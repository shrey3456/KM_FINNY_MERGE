import { Router, Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import passport from 'passport';
import { db, pool } from '../db';
import {
  orderImportSessions, orderScanItems, orderScanEvents,
  users, plants, plantStvs,
} from '../../shared/schema';
import { eq, and, or, desc, asc, gte, sql, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { broadcastOrderImportUpdate, addWsAdminClient, removeWsAdminClient } from '../lib/importEvents';
import { computeGroupReport, resolveGroupId, applyLiveScanStock, reverseLiveScanStock, reconcileCredits } from '../lib/orderGroupReport';
import { requirePageWrite } from '../lib/pageAccess';
import { sessionMiddleware } from '../auth';

// Case-insensitive plant match: LOWER(plant) = LOWER(filter)
function plantEq(filter: string) {
  return sql`LOWER(${orderImportSessions.plant}) = LOWER(${filter})`;
}

// Case-insensitive plant match against a user's assigned-plants list (already lowercased by
// getUserPlants) — the multi-plant equivalent of plantEq above. Uses drizzle-orm's inArray
// (LOWER(plant) IN ($1, $2, ...), each value its own bound parameter) rather than
// `= ANY(${filters}::text[])` — passing a raw JS array through Drizzle's `sql` template tag
// does NOT bind it as a single Postgres array parameter the way raw pg.query does; it caused
// a real "malformed array literal" 500 on every route using it (e.g. GET /order-scan/notification).
function plantIn(filters: string[]) {
  return inArray(sql`LOWER(${orderImportSessions.plant})`, filters);
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
  // sessionId is stamped onto every broadcast so a client joined to several sessions at
  // once (see the multi-join support below) can tell which one an event actually belongs
  // to — needed now that a single scan can write to a different part than the one
  // currently shown as "front" (see the dual-logging rule in the /scan handler).
  const frame = JSON.stringify({ ...payload, sessionId });
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(frame); } catch { /* client disconnected mid-send */ }
    }
  });
}

// Tells any device actively scanning against this session (joined via {type:'join',
// sessionId}) that it was just deleted — see the 'session-deleted' handler in
// client/src/pages/Scanning/Scan.tsx, which shows a toast and lets the page's normal
// active-session polling fall back to "no active session" without the scanner needing to
// hit a scan and get a confusing 404. Called from order-import.ts's DELETE handler.
export function broadcastSessionDeleted(sessionId: number) {
  broadcastScanEvent(sessionId, { type: 'session-deleted', sessionId });
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

      // Require login for this connection — same baseline as every REST route on this page
      // (requireScanRole: "any logged-in user"). The raw upgrade `request` never passes
      // through Express's own app.use(session(...)) chain on its own, so it's replayed here
      // by hand: session → passport.initialize → passport.session, then req.isAuthenticated().
      // `fakeRes` only needs to survive express-session's internal res.end/getHeader/setHeader
      // touches — no cookie is ever actually written back through this fake response, since
      // login already happened over a normal HTTP request before the browser opens this socket.
      if (!sessionMiddleware) { socket.destroy(); return; }
      const fakeRes: any = { getHeader: () => undefined, setHeader: () => {}, end: () => {}, writeHead: () => {}, on: () => {} };
      sessionMiddleware(request as any, fakeRes, () => {
        passport.initialize()(request as any, fakeRes, () => {
          passport.session()(request as any, fakeRes, () => {
            const authedReq = request as any;
            if (!authedReq.isAuthenticated || !authedReq.isAuthenticated()) {
              socket.destroy();
              return;
            }
            wss.handleUpgrade(request, socket as any, head, (ws) => {
              wss.emit('connection', ws, request);
            });
          });
        });
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

    // A client now joins every session in the current FIFO group (not just the one shown
    // as "front"), since a scan can write to a different part than the one displayed —
    // see the dual-logging rule in the /scan handler. Each 'join' message ADDS a room
    // instead of replacing the previous one, so Scan.tsx can join all of a group's parts
    // on one connection.
    const joinedSessionIds = new Set<number>();
    let joinedImport = false;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'join' && typeof msg.sessionId === 'number') {
          const sid = msg.sessionId as number;
          joinedSessionIds.add(sid);
          if (!wsClients.has(sid)) wsClients.set(sid, new Set());
          wsClients.get(sid)!.add(ws);
          const roomSize = wsClients.get(sid)!.size;
          console.log(`[WS] Client joined session ${sid} — ${roomSize} device(s) connected`);
          ws.send(JSON.stringify({ type: 'joined', sessionId: sid }));
        } else if (msg.type === 'leave' && typeof msg.sessionId === 'number') {
          const sid = msg.sessionId as number;
          joinedSessionIds.delete(sid);
          const set = wsClients.get(sid);
          if (set) { set.delete(ws); if (set.size === 0) wsClients.delete(sid); }
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
      for (const sid of joinedSessionIds) {
        const set = wsClients.get(sid);
        if (set) { set.delete(ws); if (set.size === 0) wsClients.delete(sid); }
      }
      joinedSessionIds.clear();
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

// Mirrors the client's canCompletePart gate (Scan.tsx) — anyone can complete a part EXCEPT
// designations "Loader"/"Helper"/"Driver"/"Scanner" (exact match); admin/super-admin always
// allowed regardless of designation.
function canCompletePart(user: any): boolean {
  const role = (user?.role ?? '').toLowerCase().trim();
  if (['admin', 'super-admin'].includes(role)) return true;
  const designation = (user?.designation ?? '').toLowerCase().trim();
  return !['loader', 'helper', 'driver', 'scanner'].includes(designation);
}

function requireCompleteAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  if (!canCompletePart(req.user)) {
    return res.status(403).json({ message: 'You do not have permission to complete this part.' });
  }
  next();
}

const WRITE_ADMIN_ROLES = ['admin', 'super-admin', 'superadmin', 'super_admin', 'super admin'];
function hasWriteAccess(user: any, pageKey: string): boolean {
  const role = (user?.role ?? '').toString().toLowerCase();
  if (WRITE_ADMIN_ROLES.includes(role)) return true;
  let writable: string[] = [];
  try { writable = JSON.parse(user?.pageWriteAccess || '[]'); } catch { /* default [] */ }
  return writable.includes(pageKey);
}

// Void needs Write Access via one of two INDEPENDENT paths, not a single fixed pair:
//   1. BOTH "scan-order" AND "scan-history" — the original rule, for the Scan/Scan History pages.
//   2. Just "scan-viewer" alone — the lighter, view-plus-correct-mistakes page that deliberately
//      does NOT grant any of the heavier Scan Order capabilities (scanning, completing,
//      activating, etc.), so someone can be trusted to void a mistaken scan without being able
//      to do anything else there.
// This is an OR-of-ANDs, which is why it's a dedicated function rather than just chaining
// requirePageWrite calls (chaining only ever produces AND, never OR).
function requireVoidAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const user = req.user as any;
  const role = (user?.role ?? '').toString().toLowerCase();
  if (WRITE_ADMIN_ROLES.includes(role)) return next();
  const viaScanPages = hasWriteAccess(user, 'scan-order') && hasWriteAccess(user, 'scan-history');
  const viaViewer = hasWriteAccess(user, 'scan-viewer');
  if (viaScanPages || viaViewer) return next();
  return res.status(403).json({ message: 'Write access required' });
}

const ADMIN_ROLES = ['admin', 'super-admin', 'billing'];

// Shared by every read-only /order-scan/sessions/:id/* route below: loads the session's
// plant and checks it against the caller's own assigned plants (getUserPlants). The list
// endpoints (/sessions, /active, /notification, /active-sessions) already filter by plant,
// but these per-ID detail routes previously trusted whatever id was requested — a plant-
// scoped user who already knows/guesses an id for a DIFFERENT plant could read its detail
// data. Sends the 404/403 response itself and returns null so the caller just does
// `if (!plant) return;`; returns the plant string when access is allowed.
async function checkSessionPlantOrRespond(req: Request, res: Response, sessionId: number): Promise<string | null> {
  const { rows } = await pool.query('SELECT plant FROM order_import_sessions WHERE id = $1', [sessionId]);
  if (!rows[0]) { res.status(404).json({ message: 'Session not found' }); return null; }
  const plant = rows[0].plant as string;
  const userPlants = getUserPlants(req.user);
  if (userPlants !== null && !userPlants.includes((plant ?? '').toLowerCase())) {
    res.status(403).json({ message: 'Access denied for this plant' });
    return null;
  }
  return plant;
}

// Which plant names a user may view/act on — the single source of truth for plant access
// across every page (Scan, Order Management, Overall Stock, Scan History). Returns null for
// admin/super-admin/billing → "see ALL plants, no filter". Otherwise returns EXACTLY the
// user's assigned plants from the Users page (users.plants JSON array), lowercased — no
// fallback to guessing a plant from department/role text (e.g. "Dispatch Valsad") anymore.
// An empty array (nothing assigned) means "see/do nothing" — fail closed, not fail open.
export function getUserPlants(user: any): string[] | null {
  const role = (user?.role ?? '').toLowerCase().trim();
  if (ADMIN_ROLES.includes(role)) return null; // all plants

  let assigned: string[] = [];
  try {
    const raw = user?.plants;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) assigned = parsed.map((p) => String(p).toLowerCase().trim()).filter(Boolean);
  } catch { /* default [] */ }

  return assigned;
}

// Pick correct pallet size based on the plant's STATE (products.gjPlt/mpPlt), not the plant
// itself — see getPlantStateCode below for how a plant resolves to one of these codes.
function getPalletSize(product: any, state: string | null): number {
  const s = (state ?? '').toUpperCase();
  if (s === 'GJ') return Number(product.gjPlt) || Number(product.itemsPerPallet) || 0;
  if (s === 'MP') return Number(product.mpPlt) || Number(product.itemsPerPallet) || 0;
  return Number(product.itemsPerPallet) || 0;
}

// Full pallet-size fallback chain, shared by session population and the scan handler:
// state-specific gj_plt/mp_plt → generic items_per_pallet → generic pallets column →
// parse *NNN from the product name (e.g. "16GM*192 ..." → 192). Same chain the old
// classic-scan flow used, so pallet math never silently falls back to 1.
function resolveFullPalletSize(
  product: { itemsPerPallet?: number | null; gjPlt?: number | null; mpPlt?: number | null; pallets?: number | null; name?: string | null },
  state: string | null,
): number {
  let size = getPalletSize(product, state);
  if (size === 0) size = Number(product.pallets ?? 0);
  if (size === 0 && product.name) {
    const m = String(product.name).match(/\*(\d{1,5})/);
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > 1) size = n; }
  }
  return size;
}

// Resolves a plant name to its Indian-state short code (plants.state, e.g. "GJ"/"MP") — pallet
// size lives per-state on products (gjPlt/mpPlt), not per-plant, so every pallet-size lookup
// needs this first. One query per call site (the plant doesn't change per-row), not per item.
async function getPlantStateCode(client: any, plantName: string): Promise<string | null> {
  if (!plantName) return null;
  const { rows } = await client.query(
    `SELECT state FROM plants WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [plantName],
  );
  const state = rows[0]?.state;
  return state ? String(state).trim().toUpperCase() : null;
}

// Seeds order_scan_items from order_import_items (with product/pallet lookups) for a
// single session, if they don't exist yet. Decoupled from scan_status/activation — every
// part of a FIFO group is scannable from the moment it's uploaded (sequential cross-part
// search resolves which part a barcode actually belongs to), so seeding can't wait for an
// "active" flip anymore. Safe to call from an already-open client/transaction (pass one in)
// or standalone (a pool client is grabbed and released internally).
async function seedSessionItemsWithClient(client: any, id: number, plant: string): Promise<void> {
  // Per-item idempotency (not all-or-nothing): a session can already have SOME scan items
  // seeded here — a delete-with-rollback replacement (see remapDeletedSessionScans) moves a
  // deleted session's scan items onto this one BEFORE seeding, for barcodes with prior scan
  // history. Only the remaining CSV rows still need fresh scan items.
  const existingResult = await client.query(
    'SELECT order_import_item_id AS "orderImportItemId" FROM order_scan_items WHERE session_id = $1 AND order_import_item_id IS NOT NULL',
    [id],
  );
  const alreadySeededItemIds = new Set(existingResult.rows.map((r: any) => r.orderImportItemId));

  const importItemsResult = await client.query(
    'SELECT * FROM order_import_items WHERE session_id = $1',
    [id],
  );
  const importItems = importItemsResult.rows.filter((i: any) => !alreadySeededItemIds.has(i.id));
  if (importItems.length === 0) return;

  const state = await getPlantStateCode(client, plant);
  const barcodes = importItems.map((i: any) => i.barcode).filter(Boolean);
  const productMap = new Map<string, any>();
  if (barcodes.length > 0) {
    const prodResult = await client.query(
      `SELECT barcode, name, items_per_pallet, pallets, gj_plt, mp_plt
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
      ? { gjPlt: prod.gj_plt, mpPlt: prod.mp_plt, itemsPerPallet: prod.items_per_pallet, pallets: prod.pallets, name: prod.name }
      : null;
    const palletSize = prodObj ? resolveFullPalletSize(prodObj, state) : 0;
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

// Standalone entry point for seeding a session's items outside of any other transaction —
// used right after a CSV upload so every part in a group has scannable items immediately,
// not just the one that happens to auto-activate.
export async function seedSessionItems(id: number, plant: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM order_import_sessions WHERE id = $1 FOR UPDATE', [id]);
    await seedSessionItemsWithClient(client, id, plant);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Marks a session active (the "front" part shown as primary in the UI) and makes sure its
// items are seeded. Shared by the activate route and the auto-activation paths (upload +
// completion progression). Returns true if this call actually activated the session, false
// if it was skipped (not found, or another session is already active for the plant). Safe
// to call from multiple concurrent contexts for the same plant — the advisory lock below
// serializes them so only one can win.
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

    await seedSessionItemsWithClient(client, id, session.plant);

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// After a part finishes (manually via /complete, or automatically the moment its items are
// all scanned — see the derived-completion check in the /scan handler), find the next
// not-yet-scanned part and mark it 'active' so the UI's "front" session tracking
// (/active-sessions, which filters on scan_status='active') has something to point at.
// Scanning itself no longer depends on this — every part is already seeded and scannable
// via the sequential cross-part search regardless of scan_status — but the client still
// needs ONE session flagged 'active' per plant to know what to show as primary. If this
// part belongs to a FIFO batch (receivingSessionId set), scope strictly to that batch —
// ordered by partIndex — so an unrelated 'available' session for the same plant can never
// jump the queue. Otherwise fall back to plant-wide behaviour. Either way, only proceed if
// nothing else in that scope is already active (avoid stealing an active lock).
export type ActivatedNext = { id: number; csvFileName: string; partIndex: number | null };

export async function autoActivateNextInScope(
  completed: { id: number; plant: string; receivingSessionId: number | null; csvFileName: string },
  userCode: string | null,
): Promise<ActivatedNext | null> {
  // Only one session may be active per plant, so check plant-wide (not just within the group)
  // before promoting anything — otherwise we'd try to activate while another order is mid-scan.
  const activeForPlant = await db.select({ id: orderImportSessions.id })
    .from(orderImportSessions)
    .where(and(
      sql`LOWER(${orderImportSessions.plant}) = LOWER(${completed.plant})`,
      eq(orderImportSessions.scanStatus, 'active'),
      eq(orderImportSessions.isDeleted, false),
    ))
    .limit(1);

  if (activeForPlant.length > 0) {
    console.log(`[order-scan] another session already active for plant ${completed.plant}; skip auto-progress`);
    return null;
  }

  // 1) Prefer the next part of the SAME order (FIFO within the group, by partIndex).
  let next = completed.receivingSessionId
    ? (await db.select()
        .from(orderImportSessions)
        .where(and(
          eq(orderImportSessions.receivingSessionId, completed.receivingSessionId),
          eq(orderImportSessions.scanStatus, 'available'),
          eq(orderImportSessions.isDeleted, false),
        ))
        .orderBy(asc(orderImportSessions.partIndex), asc(orderImportSessions.id))
        .limit(1))[0]
    : undefined;

  // 2) Group exhausted (or this was a standalone session) → move on to the next ORDER for this
  //    plant, earliest order date first. This is what makes "admin completes the last part of
  //    the 18th" roll straight on to the 19th's CSV instead of leaving the plant idle.
  if (!next) {
    [next] = await db.select()
      .from(orderImportSessions)
      .where(and(
        sql`LOWER(${orderImportSessions.plant}) = LOWER(${completed.plant})`,
        eq(orderImportSessions.scanStatus, 'available'),
        eq(orderImportSessions.isDeleted, false),
      ))
      .orderBy(
        asc(orderImportSessions.orderDate),   // 'YYYY-MM-DD' text sorts chronologically
        asc(orderImportSessions.partIndex),
        asc(orderImportSessions.id),
      )
      .limit(1);
  }

  if (!next) {
    console.log(`[order-scan] no more 'available' sessions for plant ${completed.plant} after completing ${completed.id}`);
    return null;
  }

  const activatedNext = await seedAndActivateSession(next.id, userCode);
  if (!activatedNext) {
    console.log(`[order-scan] auto-activate of ${next.id} lost the race (another activation won) after completing ${completed.id}`);
    return null;
  }
  console.log(`[order-scan] auto-activated next session ${next.id} (${next.csvFileName}) after completing ${completed.id}`);
  return { id: next.id, csvFileName: next.csvFileName, partIndex: next.partIndex };
}

// Auto Complete's derived-completion check only ever runs inside a /scan request, when a
// barcode scan touches a specific session — so a part that's fully scanned while it's still
// the LAST part in its group (deliberately skipped, per the last-part rule) never gets
// re-evaluated once it stops being last, because nothing will ever scan against it again
// (it has nothing left to scan). This sweep closes that gap: call it right after a new CSV
// joins an EXISTING group, so whichever part just lost "last part" status gets completed
// immediately instead of sitting fully-scanned-but-open forever. No-op if Auto Complete is
// off for the plant, or if nothing in the group is both non-last and fully scanned.
export async function sweepStaleCompletions(groupId: number, plant: string, userCode: string | null): Promise<void> {
  const { rows: plantRows } = await pool.query(
    `SELECT is_auto_complete_enabled AS "isAutoCompleteEnabled" FROM plants WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [plant],
  );
  if (plantRows[0]?.isAutoCompleteEnabled !== true) return;

  const { rows: groupSessions } = await pool.query(
    `SELECT id, plant, part_index AS "partIndex", csv_file_name AS "csvFileName", scan_status AS "scanStatus"
     FROM order_import_sessions
     WHERE (receiving_session_id = $1 OR id = $1) AND is_deleted = false
     ORDER BY part_index ASC, id ASC`,
    [groupId],
  );
  if (groupSessions.length < 2) return; // nothing can be "stuck as last" with only one part

  const lastPartId = groupSessions.reduce(
    (max: any, s: any) => ((s.partIndex ?? 0) > (max?.partIndex ?? -1) ? s : max),
    null as any,
  )?.id;

  for (const s of groupSessions) {
    if (s.id === lastPartId || s.scanStatus === 'completed') continue;

    const { rows: remainRows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status <> 'complete')::int AS remaining FROM order_scan_items WHERE session_id = $1`,
      [s.id],
    );
    if ((remainRows[0]?.remaining ?? 1) !== 0) continue; // not fully scanned yet — leave it

    const { rowCount } = await pool.query(
      `UPDATE order_import_sessions SET scan_status = 'completed', scan_completed_at = NOW()
       WHERE id = $1 AND scan_status <> 'completed'`,
      [s.id],
    );
    if (!rowCount) continue;

    console.log(`[order-scan] sweep auto-completed stale part ${s.id} (${s.csvFileName}) after it lost 'last part' status`);

    // Make any "already covered by an earlier part" credit real now that this part is
    // actually completed — same reasoning as the manual /complete endpoint.
    const creditClient = await pool.connect();
    try {
      await creditClient.query('BEGIN');
      await reconcileCredits(creditClient, s.id, groupId);
      await creditClient.query('COMMIT');
    } catch (e) {
      await creditClient.query('ROLLBACK');
      console.error('[order-scan] credit reconciliation failed during sweep:', e);
    } finally {
      creditClient.release();
    }

    const activated = await autoActivateNextInScope(
      { id: s.id, plant: s.plant, receivingSessionId: groupId, csvFileName: s.csvFileName },
      userCode,
    );
    broadcastScanEvent(s.id, {
      type: 'part-completed',
      csvFileName: s.csvFileName,
      partIndex: s.partIndex,
      nextCsvFileName: activated?.csvFileName ?? null,
      nextPartIndex: activated?.partIndex ?? null,
    });
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
    const userPlants = getUserPlants(req.user);
    const importedBy  = alias(users, 'imported_by');

    const conditions: any[] = [
      eq(orderImportSessions.scanStatus, 'active'),
      eq(orderImportSessions.isDeleted, false),
    ];
    if (userPlants !== null) conditions.push(plantIn(userPlants));

    const [session] = await db
      .select({
        id:          orderImportSessions.id,
        plant:       orderImportSessions.plant,
        csvFileName: orderImportSessions.csvFileName,
        rowCount:    orderImportSessions.rowCount,
        importedByName: importedBy.name,
        scanActivatedAt: orderImportSessions.scanActivatedAt,
        // Master View scopes by the ACTIVE session's order date (not the upload day), so the
        // client needs it here — see mvDate in Scan.tsx.
        orderDate: orderImportSessions.orderDate,
        // Upload timestamp — the Scan header shows this in place of the CSV file name.
        createdAt: orderImportSessions.createdAt,
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
// instead of only ever seeing whichever one is "on top". A non-admin user assigned to
// more than one plant on the Users page can now also see more than one active session
// here — one per plant they're assigned to.
router.get('/order-scan/active-sessions', async (req: Request, res: Response) => {
  try {
    const userPlants = getUserPlants(req.user);
    const importedBy  = alias(users, 'imported_by');

    const conditions: any[] = [
      eq(orderImportSessions.scanStatus, 'active'),
      eq(orderImportSessions.isDeleted, false),
    ];
    if (userPlants !== null) conditions.push(plantIn(userPlants));

    const sessions = await db
      .select({
        id:          orderImportSessions.id,
        plant:       orderImportSessions.plant,
        csvFileName: orderImportSessions.csvFileName,
        rowCount:    orderImportSessions.rowCount,
        importedByName: importedBy.name,
        scanActivatedAt: orderImportSessions.scanActivatedAt,
        // Master View scopes by the ACTIVE session's order date (not the upload day), so the
        // client needs it here — see mvDate in Scan.tsx.
        orderDate: orderImportSessions.orderDate,
        // Upload timestamp — the Scan header shows this in place of the CSV file name.
        createdAt: orderImportSessions.createdAt,
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

// ── GET /api/order-scan/whoami — returns what plants the server sees for this user ──
router.get('/order-scan/whoami', (req: Request, res: Response) => {
  const plants = getUserPlants(req.user);
  res.json({ role: (req.user as any)?.role, department: (req.user as any)?.department, plants });
});

// ── GET /api/order-scan/active ───────────────────────────────────────────────
// Returns the currently active session for the user's plant(s) (or null).
router.get('/order-scan/active', async (req: Request, res: Response) => {
  try {
    const userPlants = getUserPlants(req.user);
    const importedBy  = alias(users, 'imported_by');
    const activatedBy = alias(users, 'activated_by');

    const conditions: any[] = [
      eq(orderImportSessions.scanStatus, 'active'),
      eq(orderImportSessions.isDeleted, false),
    ];
    if (userPlants !== null) conditions.push(plantIn(userPlants));

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
    // A plant-restricted user may only request one of THEIR assigned plants — not trust the
    // query string outright, which would let them fetch another plant's STV list. Admin (null)
    // passes through whatever was requested. A restricted user with no ?plant= given defaults
    // to their one assigned plant when they have exactly one; with 0 or 2+, they must specify.
    const userPlants = getUserPlants(req.user);
    const requested = String(req.query.plant ?? '').trim().toLowerCase();
    let plantName: string;
    if (userPlants === null) {
      plantName = requested;
    } else if (requested) {
      if (!userPlants.includes(requested)) return res.status(403).json({ message: 'Access denied for this plant' });
      plantName = requested;
    } else {
      plantName = userPlants.length === 1 ? userPlants[0] : '';
    }
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
    const userPlants = getUserPlants(req.user);

    // Admin/billing (userPlants null) can filter by plant via query param, unrestricted
    // otherwise. A restricted user is always confined to their assigned plants; ?plant= may
    // narrow that down to just ONE of their plants if it's actually one of theirs, otherwise
    // it's ignored and every plant they're assigned to is returned.
    const queryPlant = req.query.plant ? String(req.query.plant).trim().toLowerCase() : null;
    let plantCondition: any = null;
    if (userPlants === null) {
      if (queryPlant) plantCondition = plantEq(queryPlant);
    } else {
      const scoped = queryPlant && userPlants.includes(queryPlant) ? [queryPlant] : userPlants;
      plantCondition = plantIn(scoped);
    }

    // Date filter: compare the stored timestamp's date directly (server local time),
    // consistent with how order-import.ts filters. No timezone conversion needed.
    // With no explicit ?date=, "recent" means uploaded in the last 48h OR completed in the
    // last 48h — not just uploaded. A CSV can sit as 'active'/'available' for weeks (exempt
    // from this window below via its own OR branch) while it's worked through as backlog; the
    // moment it's marked 'completed' it loses that exemption, so without also checking
    // scanCompletedAt here it would vanish from Available/Active/Completed the instant it
    // finished, just because its original upload date was long past 48h ago.
    const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
    const dateCondition = req.query.date
      ? sql`${orderImportSessions.createdAt}::date = ${String(req.query.date)}::date`
      : or(
          gte(orderImportSessions.createdAt, new Date(Date.now() - RECENT_WINDOW_MS)),
          gte(orderImportSessions.scanCompletedAt, new Date(Date.now() - RECENT_WINDOW_MS)),
        );

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
        // The date the CSV was uploaded FOR — the Order Import tabs filter and display on this
        // rather than createdAt, since the two diverge whenever a late part is added.
        orderDate:            orderImportSessions.orderDate,
        scanStatus:           orderImportSessions.scanStatus,
        scanActivatedByCode:  orderImportSessions.scanActivatedByCode,
        scanActivatedByName:  activatedBy.name,
        scanActivatedAt:      orderImportSessions.scanActivatedAt,
        scanCompletedAt:      orderImportSessions.scanCompletedAt,
        receivingSessionId:   orderImportSessions.receivingSessionId,
        partIndex:            orderImportSessions.partIndex,
        // Ordered totals across this CSV's rows. rowCount alone says how many LINES the file has,
        // which isn't what anyone means by "how big is this order" — these let the Order Import
        // tabs show the quantity without expanding every session to add it up. Mirrors the same
        // two columns on GET /order-import/sessions, which feeds the History tab.
        totalQty: sql<number>`(
          SELECT COALESCE(SUM(oii.quantity), 0)::int
          FROM order_import_items oii WHERE oii.session_id = ${orderImportSessions.id}
        )`,
        totalPallets: sql<number>`(
          SELECT COALESCE(SUM(oii.expected_pallets), 0)::float
          FROM order_import_items oii WHERE oii.session_id = ${orderImportSessions.id}
        )`,
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
          ...(plantCondition ? [plantCondition] : []),
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
// Only one active session per plant at a time. This is an Order Management page action
// ("Load for Scan"), so it's gated by Write Access to "order-import" — not "scan-order",
// which is reserved for the actual barcode-scanning actions on the Scan page itself.
router.post('/order-scan/sessions/:id/activate', requirePageWrite('order-import'), async (req: Request, res: Response) => {
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

    // Plant ownership — a user restricted to specific plants (getUserPlants returns a non-
    // null array) may only activate sessions belonging to one of THOSE plants. Admin/super-
    // admin/billing (null = unrestricted) act on any plant, same as everywhere else on this page.
    const userPlants = getUserPlants(req.user);
    if (userPlants !== null && !userPlants.includes(session.plant.toLowerCase())) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Access denied for this plant' });
    }

    // Plant-scoped advisory lock — closes a real race the row lock above does NOT: two
    // DIFFERENT sessions for the SAME plant being activated at the same instant lock two
    // different rows, so neither blocks the other, and both could read the conflict-check
    // below as "nothing active yet" before either commits. This serializes all /activate
    // calls for one plant so the second one always sees the first's committed row. Held for
    // the transaction; released automatically on COMMIT/ROLLBACK. Always the SESSION's own
    // plant (not "the user's plant" — a user can now be assigned to several).
    const lockPlant = session.plant.toLowerCase();
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockPlant]);

    // Check for a conflicting active session on the same plant (exclude deleted sessions)
    const conflictResult = await client.query(
      `SELECT id, csv_file_name FROM order_import_sessions
       WHERE LOWER(plant) = LOWER($1) AND scan_status = 'active'
         AND is_deleted = false AND id != $2`,
      [session.plant, id],
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

    // Pre-populate orderScanItems for any CSV rows not already seeded. Per-item idempotency
    // (not all-or-nothing): a session can already have SOME scan items here — a
    // delete-with-rollback replacement (see remapDeletedSessionScans) moves a deleted
    // session's scan items onto this one before activation, for barcodes with prior scan
    // history. The lock on the session row above means only one request can reach here
    // at a time, so there is no double-insert race.
    const existingResult = await client.query(
      'SELECT order_import_item_id AS "orderImportItemId" FROM order_scan_items WHERE session_id = $1 AND order_import_item_id IS NOT NULL',
      [id],
    );
    const alreadySeededItemIds = new Set(existingResult.rows.map((r: any) => r.orderImportItemId));

    const importItemsResult = await client.query(
      'SELECT * FROM order_import_items WHERE session_id = $1',
      [id],
    );
    const importItems = importItemsResult.rows.filter((i: any) => !alreadySeededItemIds.has(i.id));

    if (importItems.length > 0) {
      const state = await getPlantStateCode(client, session.plant);
      const barcodes = importItems.map((i: any) => i.barcode).filter(Boolean);
      let productMap = new Map<string, any>();
      if (barcodes.length > 0) {
        const prodResult = await client.query(
          `SELECT barcode, name, items_per_pallet, pallets, gj_plt, mp_plt
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
          ? { gjPlt: prod.gj_plt, mpPlt: prod.mp_plt, itemsPerPallet: prod.items_per_pallet, pallets: prod.pallets, name: prod.name }
          : null;
        const palletSize = prodObj ? resolveFullPalletSize(prodObj, state) : 0;
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
// Order Management page action — gated by "order-import" write access, same as activate.
router.post('/order-scan/sessions/:id/deactivate', requirePageWrite('order-import'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    const [session] = await db.select({ plant: orderImportSessions.plant })
      .from(orderImportSessions)
      .where(eq(orderImportSessions.id, id));
    if (!session) return res.status(404).json({ message: 'Session not found' });

    const userPlants = getUserPlants(req.user);
    if (userPlants !== null && !userPlants.includes((session.plant ?? '').toLowerCase())) {
      return res.status(403).json({ message: 'Access denied for this plant' });
    }

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
router.post('/order-scan/sessions/:id/complete', requireCompleteAccess, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    const [ownerCheck] = await db.select({ plant: orderImportSessions.plant })
      .from(orderImportSessions)
      .where(eq(orderImportSessions.id, id));
    if (!ownerCheck) return res.status(404).json({ message: 'Session not found' });
    const userPlants = getUserPlants(req.user);
    if (userPlants !== null && !userPlants.includes((ownerCheck.plant ?? '').toLowerCase())) {
      return res.status(403).json({ message: 'Access denied for this plant' });
    }

    // Raw pg query (not Drizzle's .update().set()) — Drizzle's timestamp column serializes
    // a JS Date via .toISOString() (UTC) before sending it, while raw pg sends the Date's
    // local (IST) wall-clock value. Every other timestamp write in this file (activate,
    // stock_applied_at) already goes through raw pg for that reason; this one must match or
    // scan_completed_at ends up ~5.5h off from scan_activated_at for the exact same instant.
    const { rows: completedRows } = await pool.query(
      `UPDATE order_import_sessions
       SET scan_status = 'completed', scan_completed_at = $1
       WHERE id = $2
       RETURNING id, plant, receiving_session_id AS "receivingSessionId", csv_file_name AS "csvFileName", part_index AS "partIndex"`,
      [new Date(), id],
    );
    const completed = completedRows[0];

    // Make any "already covered by an earlier part" credit real (writes to the later part's
    // actual total_scanned_qty/status), instead of leaving it as a display-only number that
    // Master View and Auto Complete would never agree with. See reconcileCredits for why.
    if (completed) {
      const groupId = completed.receivingSessionId ?? completed.id;
      const creditClient = await pool.connect();
      try {
        await creditClient.query('BEGIN');
        await reconcileCredits(creditClient, completed.id, groupId);
        await creditClient.query('COMMIT');
      } catch (e) {
        await creditClient.query('ROLLBACK');
        console.error('[order-scan] credit reconciliation failed:', e);
      } finally {
        creditClient.release();
      }
    }

    const next = completed
      ? await autoActivateNextInScope(completed, (req.user as any)?.userCode ?? null)
      : null;

    // Broadcast AFTER auto-activation resolves so the "big" completion popup on the Scan
    // page can say what's next in the same message, instead of a bare "Part X Complete"
    // that leaves the operator wondering what just got loaded in front of them.
    if (completed) {
      broadcastScanEvent(completed.id, {
        type: 'part-completed',
        csvFileName: completed.csvFileName,
        partIndex: completed.partIndex,
        nextCsvFileName: next?.csvFileName ?? null,
        nextPartIndex: next?.partIndex ?? null,
      });
    }

    // Stock is no longer applied here. Every scan now applies its own stock delta
    // immediately (see applyLiveScanStock in the /scan handler above), so by the time a
    // part reaches 'completed' — whether via this manual endpoint or the automatic
    // derived-completion check in /scan — its stock has already been live for a while.
    // Re-running a batch apply at this point would double-count every box in the session.
    // applySessionStock is kept as a standalone reconciliation tool (not called from any
    // route) for manually fixing stock drift if it's ever needed, not as part of this flow.

    res.json({ success: true, nextSessionId: next?.id ?? null });
    broadcastOrderImportUpdate();
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Complete failed' });
  }
});

// ── POST /api/order-scan/sessions/:id/reopen ─────────────────────────────────
// Undoes an accidental "Complete" click. Deliberately narrow: only the MOST RECENTLY
// completed session for that plant is eligible — reopening an older completed CSV would let
// scanning resume out of FIFO order against history that later parts/credits already treated
// as final (reconcileCredits may have already handed this part's leftover extras to a LATER
// part — reopening doesn't touch that, it only lets more scanning happen here). If completing
// this session auto-activated a next one, that session is demoted back to 'available' so this
// one can retake the 'active' slot — but only if the auto-activated session has no scans of
// its own yet; if it does, the admin needs to deal with that session directly instead of
// having it silently pushed aside. Order Management page action — gated by "order-import"
// write access (not the Complete designation-blocklist rule; Reopen is the undo of an Order
// Management click, not a scanning-floor decision).
router.post('/order-scan/sessions/:id/reopen', requirePageWrite('order-import'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: sessRows } = await client.query(
      `SELECT id, plant, scan_status AS "scanStatus", scan_completed_at AS "scanCompletedAt",
              csv_file_name AS "csvFileName", part_index AS "partIndex"
       FROM order_import_sessions WHERE id = $1 AND is_deleted = false FOR UPDATE`,
      [id],
    );
    const session = sessRows[0];
    if (!session) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Session not found' });
    }
    const userPlants = getUserPlants(req.user);
    if (userPlants !== null && !userPlants.includes((session.plant ?? '').toLowerCase())) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Access denied for this plant' });
    }
    if (session.scanStatus !== 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Only a completed session can be reopened.' });
    }

    // Must be the LAST completed session for this plant — nothing else completed after it.
    const { rows: laterRows } = await client.query(
      `SELECT id FROM order_import_sessions
       WHERE LOWER(plant) = LOWER($1) AND is_deleted = false AND scan_status = 'completed'
         AND (scan_completed_at > $2 OR (scan_completed_at = $2 AND id > $3))
       LIMIT 1`,
      [session.plant, session.scanCompletedAt, id],
    );
    if (laterRows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Only the most recently completed session for this plant can be reopened.' });
    }

    // Whatever auto-activated after this one completed must step aside first.
    const { rows: activeRows } = await client.query(
      `SELECT id, csv_file_name AS "csvFileName" FROM order_import_sessions
       WHERE LOWER(plant) = LOWER($1) AND is_deleted = false AND scan_status = 'active' AND id <> $2
       FOR UPDATE`,
      [session.plant, id],
    );
    const activeNext = activeRows[0];
    if (activeNext) {
      const { rows: scannedRows } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM order_scan_items WHERE session_id = $1 AND total_scanned_qty > 0`,
        [activeNext.id],
      );
      if ((scannedRows[0]?.cnt ?? 0) > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          message: `"${activeNext.csvFileName}" is already active and has scans on it — handle that session first, then reopen this one.`,
        });
      }
      await client.query(
        `UPDATE order_import_sessions
         SET scan_status = 'available', scan_activated_by_code = NULL, scan_activated_at = NULL
         WHERE id = $1`,
        [activeNext.id],
      );
    }

    await client.query(
      `UPDATE order_import_sessions SET scan_status = 'active', scan_completed_at = NULL WHERE id = $1`,
      [id],
    );

    await client.query('COMMIT');

    broadcastScanEvent(id, {
      type: 'session-reopened',
      csvFileName: session.csvFileName,
      partIndex: session.partIndex,
    });
    broadcastOrderImportUpdate();
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err instanceof Error ? err.message : 'Reopen failed' });
  } finally {
    client.release();
  }
});

// ── GET /api/order-scan/sessions/:id/items ───────────────────────────────────
router.get('/order-scan/sessions/:id/items', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    if (!(await checkSessionPlantOrRespond(req, res, id))) return;
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
      const state = await getPlantStateCode(pool, plant);
      const prodRows = await pool.query(
        `SELECT LOWER(barcode) AS barcode, name, items_per_pallet, pallets, gj_plt, mp_plt
         FROM products WHERE LOWER(barcode) = ANY($1)`,
        [barcodes],
      );
      const productMap = new Map(prodRows.rows.map((p: any) => [p.barcode, p]));
      for (const item of items) {
        const p = item.barcode ? productMap.get(item.barcode.toLowerCase()) : null;
        if (!p) continue;
        const liveIpp = resolveFullPalletSize(
          { itemsPerPallet: p.items_per_pallet, gjPlt: p.gj_plt, mpPlt: p.mp_plt, pallets: p.pallets, name: p.name },
          state,
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
    if (!(await checkSessionPlantOrRespond(req, res, id))) return;
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

// ── GET /api/order-scan/sessions/:id/group-session-ids ───────────────────────
// Cheap, purpose-built lookup (no report computation) for the client to know which
// sibling session ids belong to the same FIFO group, so it can join all of their
// WebSocket rooms at once — a scan can now land on a different part than the one
// currently shown as "front" (see the dual-logging rule in the /scan handler), and the
// client needs to hear about it live regardless of which part it displays.
router.get('/order-scan/sessions/:id/group-session-ids', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    if (!(await checkSessionPlantOrRespond(req, res, id))) return;
    const { rows } = await pool.query(
      `SELECT id FROM order_import_sessions
       WHERE is_deleted = false AND (
         id = $1 OR receiving_session_id = (SELECT COALESCE(receiving_session_id, id) FROM order_import_sessions WHERE id = $1)
       )
       ORDER BY part_index ASC, id ASC`,
      [id],
    );
    res.json({ sessionIds: rows.map((r: any) => r.id) });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to resolve group session ids' });
  }
});

// Inserts the regular/extra event(s) for one (session, item) pair and, if a regular
// portion was written, updates that session's order_scan_items row. `forceAllExtra` skips
// consuming any remaining order capacity — used for the "front part didn't have this
// barcode" leg of the dual-logging rule, where the whole qty is bookkeeping-only Extra
// against the front part regardless of whether it happens to have a (already-full) item row.
async function writeScanEvents(
  client: any,
  params: {
    sessionId: number;
    scanItem: any | null;
    totalQty: number;
    itemsPerPallet: number;
    barcode: string;
    resolvedItemName: string | null;
    stv: string | null;
    userCode: string | null;
    userName: string | null;
    forceAllExtra: boolean;
  },
): Promise<{ events: any[]; updatedItem: any; orderQty: number; extraQty: number }> {
  const { sessionId, scanItem, totalQty, itemsPerPallet, barcode, resolvedItemName, stv, userCode, userName, forceAllExtra } = params;
  const splitPallets = (q: number) => ({
    pallets: itemsPerPallet > 0 ? Math.floor(q / itemsPerPallet) : q,
    looseQty: itemsPerPallet > 0 ? q % itemsPerPallet : 0,
  });

  const remainingForOrder = (!forceAllExtra && scanItem)
    ? Math.max(0, Number(scanItem.expected_qty ?? 0) - Number(scanItem.total_scanned_qty ?? 0))
    : 0;
  const orderQty = Math.min(totalQty, remainingForOrder);
  const extraQty = totalQty - orderQty;

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

    // A pure-extra scan (orderQty === 0, e.g. this item is already fully received) never runs
    // the order_scan_items UPDATE above, so its last_scanned_at would otherwise go stale even
    // though a box against it was just scanned. Other devices' and Master View's "most recently
    // scanned floats to top" ordering reads that column (this device's own tab also has a local
    // scan-sequence counter, so it isn't affected either way) — without this, the row only
    // reorders correctly on the device that made the scan, and only until its next reload.
    if (orderQty === 0 && scanItem) {
      const touchResult = await client.query(
        `UPDATE order_scan_items SET last_scanned_at = NOW() WHERE id = $1 RETURNING *`,
        [scanItem.id],
      );
      updatedItem = touchResult.rows[0];
    }
  }

  return { events, updatedItem, orderQty, extraQty };
}

// ── POST /api/order-scan/sessions/:id/scan ───────────────────────────────────
// Records a scan event inside a serialised transaction, resolved across every part of the
// scanned session's FIFO group (not just the one session in the URL) — see the "Sequential
// search" block below. The server determines the order/extra split from the LOCKED current
// DB state — the client hint is ignored — so concurrent scans by different users never race
// on that decision.
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

    // Verify session exists and hasn't been deleted (no lock needed — session row isn't
    // mutated here). Rejecting a deleted session closes the window where a scan could land
    // on a CSV an admin just deleted-with-rollback — see remapDeletedSessionScans, which
    // reads/moves this session's scan items once a replacement is uploaded; a scan slipping
    // in after that read would be silently lost.
    const sessResult = await client.query(
      'SELECT id, plant, receiving_session_id AS "receivingSessionId" FROM order_import_sessions WHERE id = $1 AND is_deleted = false',
      [sessionId],
    );
    if (!sessResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Session not found or has been deleted' });
    }
    const anchorSession = sessResult.rows[0];

    const userPlants = getUserPlants(req.user);
    if (userPlants !== null && !userPlants.includes((anchorSession.plant ?? '').toLowerCase())) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Access denied for this plant' });
    }

    const groupId = anchorSession.receivingSessionId ?? anchorSession.id;

    // Every part of the same FIFO group is scannable at once — this scan is resolved by
    // searching the WHOLE group in partIndex order, not just the one session the client
    // happened to POST against.
    const { rows: groupSessions } = await client.query(
      `SELECT id, plant, part_index AS "partIndex", csv_file_name AS "csvFileName"
       FROM order_import_sessions
       WHERE (receiving_session_id = $1 OR id = $1) AND is_deleted = false
       ORDER BY part_index ASC, id ASC`,
      [groupId],
    );
    const sessions = groupSessions.length > 0 ? groupSessions : [anchorSession];

    // Lock this barcode's row (if any) in every part, always in the same ascending
    // partIndex order, so concurrent scans acquire locks in a consistent order and never
    // deadlock against each other.
    const itemRowsBySession = new Map<number, any | null>();
    for (const s of sessions) {
      const { rows } = await client.query(
        `SELECT * FROM order_scan_items WHERE session_id = $1 AND barcode = $2 FOR UPDATE`,
        [s.id, barcode],
      );
      itemRowsBySession.set(s.id, rows[0] ?? null);
    }

    // "Front" = earliest part (by partIndex) that still has an item not yet fully scanned.
    // Once every item in a part is complete, the front moves to the next part automatically
    // on the very next scan — no admin action needed for that to take effect.
    const { rows: incompleteCounts } = await client.query(
      `SELECT session_id AS "sessionId", COUNT(*) FILTER (WHERE status <> 'complete')::int AS "incomplete"
       FROM order_scan_items WHERE session_id = ANY($1::int[]) GROUP BY session_id`,
      [sessions.map((s: any) => s.id)],
    );
    const incompleteBySession = new Map(incompleteCounts.map((r: any) => [r.sessionId, r.incomplete]));
    const frontSession = sessions.find((s: any) => (incompleteBySession.get(s.id) ?? 0) > 0) ?? sessions[sessions.length - 1];

    // Sequential search: front part first, then the next, then the next — the first part
    // whose CSV still has room left for this barcode wins the "Scanned" credit.
    let matchedSession: any = null;
    let matchedItem: any = null;
    for (const s of sessions) {
      const item = itemRowsBySession.get(s.id);
      if (item && Number(item.expected_qty ?? 0) - Number(item.total_scanned_qty ?? 0) > 0) {
        matchedSession = s; matchedItem = item; break;
      }
    }

    // Always look up name AND plant-specific pallet size fresh from live inventory —
    // even when the barcode matches a CSV item. order_scan_items.items_per_pallet is only
    // a one-time snapshot taken when the session was seeded; if the product's pallet config
    // was blank at that moment and got filled in on the Products page afterward, every scan
    // against that CSV item would silently keep using the stale 0 forever, recording 1 box =
    // 1 "pallet". Resolving live here means pallet math is always correct regardless of when
    // the product's config was set relative to seeding.
    let resolvedItemName: string | null = (matchedItem ?? itemRowsBySession.get(frontSession.id))?.item_name ?? null;
    let resolvedIpp = Number((matchedItem ?? itemRowsBySession.get(frontSession.id))?.items_per_pallet ?? 0);
    const prodResult = await client.query(
      `SELECT name, items_per_pallet, pallets, gj_plt, mp_plt
       FROM products WHERE LOWER(barcode) = LOWER($1) LIMIT 1`,
      [barcode],
    );
    if (prodResult.rows[0]) {
      const p = prodResult.rows[0];
      resolvedItemName = resolvedItemName ?? p.name ?? null;
      const state = await getPlantStateCode(client, anchorSession.plant ?? '');
      const liveIpp = resolveFullPalletSize(
        { itemsPerPallet: p.items_per_pallet, gjPlt: p.gj_plt, mpPlt: p.mp_plt, pallets: p.pallets, name: p.name },
        state,
      );
      if (liveIpp > 0) resolvedIpp = liveIpp;
    }
    const itemsPerPallet = resolvedIpp;

    const totalQty = qty != null
      ? Math.max(1, Math.round(qty))
      : Math.round(pallets * Math.max(1, itemsPerPallet)) + looseQty;
    const userCode = (req.user as any)?.userCode ?? null;
    const userName  = (req.user as any)?.name ?? null;

    const baseParams = { totalQty, itemsPerPallet, barcode, resolvedItemName, stv, userCode, userName };
    const events: Array<any & { __sessionId: number }> = [];
    let updatedItem: any = null;
    let stockOrderQty = 0;
    let stockExtraQty = 0;
    let stockLedgerSessionId = frontSession.id;
    const touchedSessions = new Set<number>([frontSession.id]);

    if (matchedSession && matchedSession.id === frontSession.id) {
      // Found in the front part — the simple case, same as a single-part scan.
      const r = await writeScanEvents(client, { ...baseParams, sessionId: matchedSession.id, scanItem: matchedItem, forceAllExtra: false });
      events.push(...r.events.map((e: any) => ({ ...e, __sessionId: matchedSession.id })));
      updatedItem = r.updatedItem;
      stockOrderQty = r.orderQty; stockExtraQty = r.extraQty; stockLedgerSessionId = matchedSession.id;
    } else if (matchedSession) {
      // Not on the front part's CSV, but found further down the sequence — dual-log per the
      // spec: Extra against the front part's report AND Scanned against the part that
      // actually matched. Same physical box, two bookkeeping entries; stock (below) is only
      // ever applied once, from the matched part's real split.
      const frontItem = itemRowsBySession.get(frontSession.id) ?? null;
      const rFront = await writeScanEvents(client, { ...baseParams, sessionId: frontSession.id, scanItem: frontItem, forceAllExtra: true });
      events.push(...rFront.events.map((e: any) => ({ ...e, __sessionId: frontSession.id })));

      const rMatch = await writeScanEvents(client, { ...baseParams, sessionId: matchedSession.id, scanItem: matchedItem, forceAllExtra: false });
      events.push(...rMatch.events.map((e: any) => ({ ...e, __sessionId: matchedSession.id })));
      updatedItem = rMatch.updatedItem;
      touchedSessions.add(matchedSession.id);
      stockOrderQty = rMatch.orderQty; stockExtraQty = rMatch.extraQty; stockLedgerSessionId = matchedSession.id;
    } else {
      // Not found anywhere in the group — pure Extra against the front part.
      const frontItem = itemRowsBySession.get(frontSession.id) ?? null;
      const rFront = await writeScanEvents(client, { ...baseParams, sessionId: frontSession.id, scanItem: frontItem, forceAllExtra: true });
      events.push(...rFront.events.map((e: any) => ({ ...e, __sessionId: frontSession.id })));
      updatedItem = rFront.updatedItem;
      stockOrderQty = rFront.orderQty; stockExtraQty = rFront.extraQty; stockLedgerSessionId = frontSession.id;
    }

    // Live stock — applied exactly once per physical scan, from the real order/extra split
    // above, never once per bookkeeping event. This is what keeps the dual-logging rule from
    // ever double-counting real inventory.
    await applyLiveScanStock(client, anchorSession.plant, barcode, stockOrderQty, stockExtraQty, stockLedgerSessionId);

    // Derived auto-completion — gated by the plant's "Auto Complete" setting (Plant
    // Settings page). OFF (default): skip entirely, every part stays manual-only. ON: any
    // touched session whose items are now all 'complete' flips to scan_status='completed'
    // automatically, EXCEPT the last part of the group (or the only session in a standalone
    // import) — that one always waits for the manual Complete button, regardless of the
    // setting, so there's always a deliberate final review before an order fully closes out.
    const { rows: plantRows } = await client.query(
      `SELECT is_auto_complete_enabled AS "isAutoCompleteEnabled" FROM plants WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [anchorSession.plant],
    );
    const autoCompleteEnabled = plantRows[0]?.isAutoCompleteEnabled === true;
    const lastPartId = sessions.reduce(
      (max: any, s: any) => ((s.partIndex ?? 0) > (max?.partIndex ?? -1) ? s : max),
      null as any,
    )?.id;

    const newlyCompleted: number[] = [];
    if (autoCompleteEnabled) {
      for (const sid of touchedSessions) {
        if (sid === lastPartId) continue; // last part: always manual, never auto
        const { rows: remainRows } = await client.query(
          `SELECT COUNT(*) FILTER (WHERE status <> 'complete')::int AS remaining FROM order_scan_items WHERE session_id = $1`,
          [sid],
        );
        if ((remainRows[0]?.remaining ?? 1) === 0) {
          const { rowCount } = await client.query(
            `UPDATE order_import_sessions SET scan_status = 'completed', scan_completed_at = NOW()
             WHERE id = $1 AND scan_status <> 'completed'`,
            [sid],
          );
          if (rowCount) newlyCompleted.push(sid);
        }
      }
    }

    // Make any "already covered by an earlier part" credit real for each part that just
    // completed — same reasoning as the manual /complete endpoint (see reconcileCredits).
    for (const sid of newlyCompleted) {
      await reconcileCredits(client, sid, groupId);
    }

    await client.query('COMMIT');

    // Promote the next part to 'active' for each part that just auto-completed, so the
    // UI's /active-sessions lookup (which only ever shows scan_status='active' sessions)
    // still has a "front" to display — scanning itself doesn't need this (every part is
    // already seeded and scannable), but the client's session picker does. Must run in its
    // own connection/transaction AFTER the commit above (seedAndActivateSession takes its
    // own row lock on the next session).
    for (const sid of newlyCompleted) {
      const s = sessions.find((x: any) => x.id === sid);
      if (!s) continue;
      const activated = await autoActivateNextInScope(
        { id: sid, plant: s.plant, receivingSessionId: anchorSession.receivingSessionId, csvFileName: s.csvFileName },
        userCode,
      );
      broadcastScanEvent(sid, {
        type: 'part-completed',
        csvFileName: s.csvFileName,
        partIndex: s.partIndex,
        nextCsvFileName: activated?.csvFileName ?? null,
        nextPartIndex: activated?.partIndex ?? null,
      });
      if (activated) broadcastOrderImportUpdate();
    }

    // Broadcast after commit so subscribers always see the committed state — routed to
    // whichever session(s) each event actually belongs to. Not restricted to non-extra events:
    // a pure-extra scan against an already-received item still touches that item's
    // last_scanned_at (see writeScanEvents) and other devices need that update too, or the
    // item only floats to the top of their CSV Items / Master View list on the device that
    // actually made the scan.
    for (const event of events) {
      const isForUpdatedItem = updatedItem && event.scan_item_id === updatedItem.id;
      broadcastScanEvent(event.__sessionId, {
        type: 'scan',
        item: isForUpdatedItem ? {
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
    if (!(await checkSessionPlantOrRespond(req, res, id))) return;
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
        AND ose.barcode <> 'EMPTY_BOX'
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
    if (!(await checkSessionPlantOrRespond(req, res, id))) return;
    // Defaults to the 20 most recent, as before. ?limit= raises that for callers that need the
    // whole part rather than a recent-activity peek — the Scan Viewer's STV filter reads every
    // event to work out which items went out on which truck, since STV is recorded per event and
    // appears nowhere on the per-item rows its table is built from. Capped so a bad value can't
    // ask for an unbounded result set.
    const limit = Math.max(1, Math.min(5000, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const events = await db.select().from(orderScanEvents)
      .where(eq(orderScanEvents.sessionId, id))
      .orderBy(desc(orderScanEvents.scannedAt))
      .limit(limit);
    res.json(events);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch events' });
  }
});

// ── POST /api/order-scan/events/:id/void ─────────────────────────────────────
// Admin, or anyone granted Write Access to BOTH the "scan-order" and "scan-history" pages,
// OR (independently) Write Access to just "scan-viewer" alone — see requireVoidAccess above
// for why this needs to be an OR-of-ANDs rather than a simple chained-middleware AND. Marks a
// single scan event as a mistake:
// the row stays in history (never deleted) but its quantity is reversed out of the linked
// order_scan_items row AND out of stock (product_plant_stock / stock_movements /
// products.in_stock), mirroring exactly what the original /scan increment did, in reverse.
// Allowed regardless of whether the part has since been completed — a correction needs to
// be possible after the fact, not just while it's still open. Blocked only if this exact
// event has already been used as a FIFO credit source for a later part (credited_qty > 0) —
// voiding it out from under that credit would leave the later part's numbers wrong with
// nothing pointing at why; that credit would need to be dealt with first — void the later
// part's own credit-transfer row instead, which IS handled here: see the is_credit branch
// below, which reimburses this event's credited_qty instead of reversing stock a second time.
// Voiding a genuine Regular scan also auto-backfills the resulting shortfall from any leftover
// Extra scanned for the same item on this same part, if one exists (see the block right after
// the item update below) — so an Extra sitting next to a voided Regular gets put to use instead
// of just sitting there unused while the item shows short.
router.post('/order-scan/events/:id/void', requireVoidAccess, async (req: Request, res: Response) => {
  const eventId = parseInt(req.params.id);
  if (isNaN(eventId)) return res.status(400).json({ message: 'Invalid event ID' });

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
    if (Number(event.credited_qty ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Part of this scan has already been credited to a later part — void that credited entry first.' });
    }

    const sessResult = await client.query(
      `SELECT plant FROM order_import_sessions WHERE id = $1`,
      [event.session_id],
    );
    const plant = sessResult.rows[0]?.plant as string | undefined;

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

        // Voiding a genuine Regular scan (not an Extra, not a credit-transfer row) can leave
        // this item short again. If there's leftover, not-yet-used Extra scanned for the same
        // barcode on this same part, pull it in to cover the gap automatically — oldest first.
        // Prefer converting the ACTUAL Extra row itself (is_extra: true → false, in place, same
        // id, same original scanner/timestamp) rather than leaving it alone and writing a new
        // synthetic row next to it — that's the common case, when a row's whole remaining amount
        // is used. Only when a row has to be SPLIT (part of it covers this shortfall, part stays
        // Extra, or part of it was already spoken for by a different part's forward credit) does
        // a second row get written, for just the split-off portion — the minimum needed to keep
        // both halves accurate. Either way, voiding this later is already handled by the
        // is_credit branch below. Total stock on hand doesn't change here — these boxes were
        // already counted when the Extra was originally scanned — but the "Extra" bucket in
        // product_plant_stock.extra_qty shrinks by the same amount, since that many boxes are no
        // longer sitting around uncommitted; they now count toward this order.
        if (!event.is_extra && !event.is_credit) {
          let shortfall = Math.max(0, Number(updatedItem.expected_qty ?? 0) - Number(updatedItem.total_scanned_qty ?? 0));
          if (shortfall > 0) {
            const { rows: extraEvents } = await client.query(
              `SELECT id, total_qty, credited_qty
               FROM order_scan_events
               WHERE session_id = $1 AND barcode = $2 AND is_extra = true AND voided IS NOT TRUE
                 AND total_qty > COALESCE(credited_qty, 0)
               ORDER BY scanned_at ASC, id ASC
               FOR UPDATE`,
              [event.session_id, event.barcode],
            );
            for (const ex of extraEvents) {
              if (shortfall <= 0) break;
              const alreadyCredited = Number(ex.credited_qty ?? 0);
              const available = Number(ex.total_qty) - alreadyCredited;
              if (available <= 0) continue;
              const take = Math.min(available, shortfall);
              const wholeRowUnclaimed = alreadyCredited === 0 && take === Number(ex.total_qty);

              if (wholeRowUnclaimed) {
                // This row's entire amount is going toward this shortfall and nothing else has
                // ever claimed part of it — just flip it, no new row. Scan history then shows
                // this exact entry as Regular, exactly as it would if it'd been scanned that way
                // to begin with (same scanner, same timestamp).
                await client.query(
                  `UPDATE order_scan_events SET is_extra = false, is_credit = true WHERE id = $1`,
                  [ex.id],
                );
              } else {
                // Only part of this row is being converted — the rest either stays Extra or was
                // already claimed elsewhere. Reserve it via credited_qty (never mutate the
                // original row's total_qty — it stays an accurate record of what was actually
                // scanned) and write one small linked row for just the converted portion.
                await client.query(
                  `UPDATE order_scan_events SET credited_qty = COALESCE(credited_qty, 0) + $1 WHERE id = $2`,
                  [take, ex.id],
                );
                await client.query(
                  `INSERT INTO order_scan_events
                     (session_id, scan_item_id, barcode, item_name, pallets, loose_qty, total_qty,
                      items_per_pallet, is_extra, scanned_by_name, is_credit, credit_source_event_id)
                   VALUES ($1,$2,$3,$4,0,0,$5,0,false,$6,true,$7)`,
                  [event.session_id, item.id, event.barcode, event.item_name, take, 'System (backfilled from Extra after void)', ex.id],
                );
              }

              if (plant) {
                const { rows: pps } = await client.query(
                  `UPDATE product_plant_stock
                   SET extra_qty = GREATEST(0, extra_qty - $1), updated_at = NOW()
                   WHERE LOWER(barcode) = LOWER($2) AND LOWER(plant) = LOWER($3)
                   RETURNING product_id`,
                  [take, event.barcode, plant],
                );
                await client.query(
                  `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, session_id, created_at)
                   VALUES ($1, $2, $3, 0, $4, 'adjust', $5, $6, NOW())`,
                  [event.barcode, pps[0]?.product_id ?? null, plant, -take, 'Extra reclassified to Regular — backfilled a shortfall left by a voided scan', event.session_id],
                );
              }

              const backfillResult = await client.query(
                `UPDATE order_scan_items
                 SET total_scanned_qty = COALESCE(total_scanned_qty, 0) + $1,
                     status = CASE
                       WHEN COALESCE(total_scanned_qty, 0) + $1 >= expected_qty THEN 'complete'
                       WHEN COALESCE(total_scanned_qty, 0) + $1 > 0             THEN 'partial'
                       ELSE 'pending'
                     END,
                     last_scanned_at = NOW()
                 WHERE id = $2
                 RETURNING *`,
                [take, item.id],
              );
              updatedItem = backfillResult.rows[0];

              shortfall -= take;
            }
          }
        }
      }
    }

    // Undoing a same-part backfill takes two different shapes depending on how it was created
    // (see the block above). A row that was flipped IN PLACE from Extra to Regular (no separate
    // credit_source_event_id — this event IS the original Extra event) needs to be un-flipped,
    // not marked voided: marking it voided would exclude it from BOTH Regular AND active-Extra
    // tracking, and those boxes would just disappear. Un-flipping puts it back exactly as it
    // was — active, and counted as Extra again — so this returns early instead of falling
    // through to the generic "mark voided" step below.
    if (event.is_credit && !event.credit_source_event_id) {
      const unflipResult = await client.query(
        `UPDATE order_scan_events SET is_extra = true, is_credit = false WHERE id = $1 RETURNING *`,
        [eventId],
      );
      if (plant && event.barcode) {
        const qty = Number(event.total_qty ?? 0);
        const { rows: pps } = await client.query(
          `UPDATE product_plant_stock
           SET extra_qty = extra_qty + $1, updated_at = NOW()
           WHERE LOWER(barcode) = LOWER($2) AND LOWER(plant) = LOWER($3)
           RETURNING product_id`,
          [qty, event.barcode, plant],
        );
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, session_id, created_at)
           VALUES ($1, $2, $3, 0, $4, 'adjust', $5, $6, NOW())`,
          [event.barcode, pps[0]?.product_id ?? null, plant, qty, 'Un-did a backfill conversion — restored to Extra', event.session_id],
        );
      }
      await client.query('COMMIT');
      return res.json({ event: unflipResult.rows[0], updatedItem });
    }

    // A system-generated credit-transfer row (see reconcileCredits, and the same-part backfill
    // block above, for the split case) never added new stock — it just reassigned boxes an
    // earlier Extra scan already added. Reversing stock for it here would remove those boxes a
    // second time. Instead, give the qty back to the source Extra event so it's available again.
    if (event.is_credit && event.credit_source_event_id) {
      const { rows: srcRows } = await client.query(
        `SELECT session_id, barcode FROM order_scan_events WHERE id = $1 FOR UPDATE`,
        [event.credit_source_event_id],
      );
      const src = srcRows[0];

      await client.query(
        `UPDATE order_scan_events SET credited_qty = GREATEST(0, COALESCE(credited_qty, 0) - $1) WHERE id = $2`,
        [Number(event.total_qty ?? 0), event.credit_source_event_id],
      );

      // Only the same-part backfill (above) pulled this qty out of product_plant_stock's Extra
      // bucket when it was created — give it back there too, but only in that case. A forward
      // credit to a LATER part (reconcileCredits) never touched extra_qty in the first place
      // (same session_id on both sides is what tells these two apart).
      if (src && plant && Number(src.session_id) === Number(event.session_id)) {
        const qty = Number(event.total_qty ?? 0);
        const { rows: pps } = await client.query(
          `UPDATE product_plant_stock
           SET extra_qty = extra_qty + $1, updated_at = NOW()
           WHERE LOWER(barcode) = LOWER($2) AND LOWER(plant) = LOWER($3)
           RETURNING product_id`,
          [qty, src.barcode, plant],
        );
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, session_id, created_at)
           VALUES ($1, $2, $3, 0, $4, 'adjust', $5, $6, NOW())`,
          [src.barcode, pps[0]?.product_id ?? null, plant, qty, 'Voided a backfill — qty restored to Extra', event.session_id],
        );
      }
    } else if (plant && event.barcode) {
      const qty = Number(event.total_qty ?? 0);
      await reverseLiveScanStock(
        client, plant, event.barcode,
        event.is_extra ? 0 : qty,
        event.is_extra ? qty : 0,
        event.session_id,
      );
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

// ── Empty Box (order-scan) ───────────────────────────────────────────────────
// An "Empty Box" is a box the operator receives with no item/barcode to scan. It's logged as
// an ordinary order_scan_events row — NOT a separate table and with NO dedicated flag column —
// identified purely by the reserved sentinel barcode 'EMPTY_BOX' (no real numeric SKU can
// collide). That keeps it out of every order/extra/stock total for free:
//   • received qty comes from order_scan_items (an empty box creates none),
//   • extra qty comes from is_extra=true events (an empty box is is_extra=false),
//   • stock joins on real product barcodes ('EMPTY_BOX' matches no product/plant-stock row).
// So it can never trip the quantity-breach popup or falsely complete a part. Its qty lives in
// total_qty; its optional note lives in item_name as 'Empty Box' or 'Empty Box: <note>'; undo
// is a soft-void (voided=true).
const EMPTY_BOX_BARCODE = 'EMPTY_BOX';
// item_name is 'Empty Box' with no note, or 'Empty Box: <note>' with one. This SQL fragment
// pulls the note back out (NULL when there's just the bare label). Keep in sync with the label
// built in the POST handler below.
const EMPTY_BOX_NOTE_SQL = `CASE WHEN item_name LIKE 'Empty Box: %' THEN SUBSTRING(item_name FROM 12) ELSE NULL END`;

// Running totals of non-voided empty boxes for a session: count = number of entries,
// totalQty = sum of their quantities. Both power the reconciliation figure in the UI.
async function getEmptyBoxSummary(sessionId: number) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS "count", COALESCE(SUM(total_qty), 0)::int AS "totalQty"
     FROM order_scan_events
     WHERE session_id = $1 AND barcode = $2 AND voided IS NOT TRUE`,
    [sessionId, EMPTY_BOX_BARCODE],
  );
  return { count: rows[0]?.count ?? 0, totalQty: rows[0]?.totalQty ?? 0 };
}

// ── GET /api/order-scan/sessions/:id/empty-boxes ─────────────────────────────
// List of non-voided empty box entries for a session, plus the running summary.
router.get('/order-scan/sessions/:id/empty-boxes', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    if (!(await checkSessionPlantOrRespond(req, res, id))) return;
    const { rows: entries } = await pool.query(
      `SELECT id, session_id AS "sessionId", total_qty AS quantity, ${EMPTY_BOX_NOTE_SQL} AS note,
              scanned_by_code AS "scannedByCode", scanned_by_name AS "scannedByName",
              scanned_at AS "scannedAt"
       FROM order_scan_events
       WHERE session_id = $1 AND barcode = $2 AND voided IS NOT TRUE
       ORDER BY id DESC`,
      [id, EMPTY_BOX_BARCODE],
    );
    res.json({ ...(await getEmptyBoxSummary(id)), entries });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch empty boxes' });
  }
});

// ── POST /api/order-scan/sessions/:id/empty-box ──────────────────────────────
// Log an empty box against a session. No barcode/CSV lookup — a separate action from a
// product scan. quantity defaults to 1; an optional note is kept for audit. Blocked once
// the session is completed (its numbers are finalized, same rule as voiding a scan).
router.post('/order-scan/sessions/:id/empty-box', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

  const rawQty = Number(req.body?.quantity ?? 1);
  const quantity = Number.isFinite(rawQty) ? Math.max(1, Math.floor(rawQty)) : 1;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null;
  // Note is folded into item_name (no dedicated column): 'Empty Box' or 'Empty Box: <note>'.
  const itemName = note ? `Empty Box: ${note}` : 'Empty Box';
  const userCode = (req.user as any)?.userCode ?? null;
  const userName = (req.user as any)?.name ?? null;

  try {
    const { rows: sessRows } = await pool.query(
      `SELECT scan_status AS "scanStatus", plant FROM order_import_sessions WHERE id = $1 AND is_deleted = false`,
      [id],
    );
    if (!sessRows[0]) return res.status(404).json({ message: 'Session not found or has been deleted' });
    const userPlants = getUserPlants(req.user);
    if (userPlants !== null && !userPlants.includes((sessRows[0].plant ?? '').toLowerCase())) {
      return res.status(403).json({ message: 'Access denied for this plant' });
    }
    if (sessRows[0].scanStatus === 'completed') {
      return res.status(400).json({ message: 'This part is already completed — empty boxes can no longer be added.' });
    }

    // Sentinel barcode + is_extra=false + scan_item_id=null — see the block comment above for
    // why this keeps empty boxes out of every quantity/stock aggregation.
    const { rows: inserted } = await pool.query(
      `INSERT INTO order_scan_events
         (session_id, scan_item_id, barcode, item_name, pallets, loose_qty, total_qty,
          items_per_pallet, is_extra, scanned_by_code, scanned_by_name)
       VALUES ($1, NULL, $2, $3, 0, $4, $4, 0, false, $5, $6)
       RETURNING id, session_id AS "sessionId", total_qty AS quantity, ${EMPTY_BOX_NOTE_SQL} AS note,
                 scanned_by_code AS "scannedByCode", scanned_by_name AS "scannedByName", scanned_at AS "scannedAt"`,
      [id, EMPTY_BOX_BARCODE, itemName, quantity, userCode, userName],
    );

    const summary = await getEmptyBoxSummary(id);
    res.status(201).json({ entry: inserted[0], ...summary });

    broadcastScanEvent(id, { type: 'empty-box', sessionId: id, ...summary });
    broadcastOrderImportUpdate();
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to log empty box' });
  }
});

// ── POST /api/order-scan/empty-box/:id/undo ──────────────────────────────────
// Undo/remove an empty box marked by mistake. Soft-void (keeps the audit row) so it drops
// out of counts/reports. Any scan-order writer can undo (it's operator self-correction).
// Scoped to the sentinel barcode so this can never void a real product scan.
router.post('/order-scan/empty-box/:id/undo', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id);
  if (isNaN(entryId)) return res.status(400).json({ message: 'Invalid entry ID' });
  const userCode = (req.user as any)?.userCode ?? null;

  try {
    const { rows: ownerRows } = await pool.query(
      `SELECT ois.plant FROM order_scan_events ose
       JOIN order_import_sessions ois ON ois.id = ose.session_id
       WHERE ose.id = $1 AND ose.barcode = $2`,
      [entryId, EMPTY_BOX_BARCODE],
    );
    if (!ownerRows[0]) return res.status(404).json({ message: 'Empty box entry not found or already removed' });
    const userPlants = getUserPlants(req.user);
    if (userPlants !== null && !userPlants.includes((ownerRows[0].plant ?? '').toLowerCase())) {
      return res.status(403).json({ message: 'Access denied for this plant' });
    }

    const { rows } = await pool.query(
      `UPDATE order_scan_events
       SET voided = true, voided_by_code = $1, voided_at = NOW()
       WHERE id = $2 AND barcode = $3 AND voided IS NOT TRUE
       RETURNING session_id AS "sessionId"`,
      [userCode, entryId, EMPTY_BOX_BARCODE],
    );
    if (!rows[0]) return res.status(404).json({ message: 'Empty box entry not found or already removed' });

    const sessionId = rows[0].sessionId;
    const summary = await getEmptyBoxSummary(sessionId);
    res.json({ success: true, sessionId, ...summary });

    broadcastScanEvent(sessionId, { type: 'empty-box', sessionId, ...summary });
    broadcastOrderImportUpdate();
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to undo empty box' });
  }
});

export default router;
