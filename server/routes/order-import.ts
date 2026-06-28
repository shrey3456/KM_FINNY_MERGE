import { Router, Request, Response, NextFunction } from 'express';
import { db, pool } from '../db';
import { orderImportSessions, orderImportItems, users } from '../../shared/schema';
import { eq, desc, and, sql } from 'drizzle-orm';
import { addSseClient, removeSseClient, broadcastOrderImportUpdate } from '../lib/importEvents';
import { seedAndActivateSession } from './order-scan';

export { broadcastOrderImportUpdate };

const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const role = ((req.user as any)?.role ?? '').toLowerCase();
  if (!['admin', 'super-admin', 'billing'].includes(role))
    return res.status(403).json({ message: 'Access required' });
  next();
}

router.use('/order-import', requireAdmin);

// Never let a reverse proxy (IIS ARR) or browser cache live order-import data —
// polling and WebSocket-triggered refetches must always reflect current state.
router.use('/order-import', (_req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// GET /api/order-import/stream  ── SSE: real-time change notifications
// Client connects once; server pushes "data: update\n\n" after any mutation.
// X-Accel-Buffering: no  — disables nginx proxy buffering so events arrive instantly.
router.get('/order-import/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Confirm the stream is open to the client immediately
  res.write(':connected\n\n');

  addSseClient(res);

  // Heartbeat every 25 s keeps the connection alive through reverse proxies
  // that close idle TCP connections (IIS ARR default = 30 s).
  const heartbeat = setInterval(() => {
    try { res.write(':ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25_000);

  req.on('close', () => {
    removeSseClient(res);
    clearInterval(heartbeat);
  });
});

// GET /api/order-import/sessions?page=1&pageSize=10&date=YYYY-MM-DD
router.get('/order-import/sessions', async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page     ?? '1')));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '10'))));

    const dateCondition = req.query.date
      ? sql`(${orderImportSessions.createdAt})::date = ${String(req.query.date)}::date`
      : null;

    const plantCondition = req.query.plant
      ? sql`LOWER(${orderImportSessions.plant}) = LOWER(${String(req.query.plant)})`
      : null;

    const conditions = [
      eq(orderImportSessions.isDeleted, false),
      dateCondition,
      plantCondition,
    ].filter(Boolean);

    const where = and(...(conditions as any[]));

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(orderImportSessions)
      .where(where);

    const sessions = await db
      .select({
        id:             orderImportSessions.id,
        plant:          orderImportSessions.plant,
        csvFileName:    orderImportSessions.csvFileName,
        rowCount:       orderImportSessions.rowCount,
        importedByCode: orderImportSessions.importedByCode,
        importedByName: users.name,
        createdAt:      orderImportSessions.createdAt,
        scanStatus:     orderImportSessions.scanStatus,
      })
      .from(orderImportSessions)
      .leftJoin(users, eq(orderImportSessions.importedByCode, users.userCode))
      .where(where)
      .orderBy(desc(orderImportSessions.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    res.json({ sessions, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch sessions' });
  }
});

// POST /api/order-import/sessions  — create session + bulk-insert items
router.post('/order-import/sessions', async (req: Request, res: Response) => {
  try {
    const { plant, csvFileName, items } = req.body as {
      plant: string;
      csvFileName: string;
      items: Array<{
        barcode?: string;
        itemName?: string;
        sapCode?: string;
        quantity?: number;
        expectedPallets?: number;
      }>;
    };

    if (!plant || !csvFileName || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ message: 'plant, csvFileName and items are required' });

    const userCode = (req.user as any)?.userCode ?? null;

    const [session] = await db
      .insert(orderImportSessions)
      .values({ plant, csvFileName, rowCount: items.length, importedByCode: userCode })
      .returning();

    const rows = items.map((item) => ({
      sessionId: session.id,
      plant,
      barcode: item.barcode || null,
      itemName: item.itemName || null,
      sapCode: item.sapCode || null,
      quantity: item.quantity ?? 0,
      expectedPallets: item.expectedPallets ?? null,
    }));

    await db.insert(orderImportItems).values(rows);

    // ── Auto-activate ──────────────────────────────────────────────────────────
    // If nothing is currently being scanned for this plant, immediately make this
    // freshly-uploaded CSV the active scan session so dispatch can start scanning
    // without anyone manually picking it. If a session is already active, leave it
    // alone — completion auto-progression will pick this one up later in turn.
    let activated = false;
    const activeForPlant = await db.select({ id: orderImportSessions.id })
      .from(orderImportSessions)
      .where(and(
        sql`LOWER(${orderImportSessions.plant}) = LOWER(${plant})`,
        eq(orderImportSessions.scanStatus, 'active'),
        eq(orderImportSessions.isDeleted, false),
      ))
      .limit(1);

    if (activeForPlant.length === 0) {
      await seedAndActivateSession(session.id, userCode);
      activated = true;
      console.log(`[order-import] auto-activated uploaded session ${session.id} (${csvFileName}) — no active session for plant ${plant}`);
    } else {
      console.log(`[order-import] uploaded session ${session.id} left 'available' — plant ${plant} already has an active session`);
    }

    res.status(201).json({ success: true, session, rowCount: rows.length, activated });

    // Push change event AFTER responding so client response is never delayed
    broadcastOrderImportUpdate();
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Import failed' });
  }
});

// GET /api/order-import/sessions/:id/items
router.get('/order-import/sessions/:id/items', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: items } = await pool.query(`
      SELECT
        oi.id,
        oi.session_id   AS "sessionId",
        oi.barcode,
        oi.item_name    AS "itemName",
        oi.sap_code     AS "sapCode",
        oi.quantity,
        oi.expected_pallets AS "expectedPallets",
        (SELECT total_scanned_qty FROM order_scan_items osi
          WHERE osi.order_import_item_id = oi.id
             OR (osi.order_import_item_id IS NULL
                 AND osi.session_id = oi.session_id
                 AND osi.barcode IS NOT DISTINCT FROM oi.barcode)
          ORDER BY osi.id DESC LIMIT 1)          AS "scannedQty",
        (SELECT status FROM order_scan_items osi
          WHERE osi.order_import_item_id = oi.id
             OR (osi.order_import_item_id IS NULL
                 AND osi.session_id = oi.session_id
                 AND osi.barcode IS NOT DISTINCT FROM oi.barcode)
          ORDER BY osi.id DESC LIMIT 1)          AS "scanStatus"
      FROM order_import_items oi
      WHERE oi.session_id = $1
      ORDER BY oi.id
    `, [id]);
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch items' });
  }
});

// PUT /api/order-import/sessions/:id  — replace all items (re-import with new CSV)
router.put('/order-import/sessions/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

    const { csvFileName, items } = req.body as {
      csvFileName: string;
      items: Array<{
        barcode?: string;
        itemName?: string;
        sapCode?: string;
        quantity?: number;
        expectedPallets?: number;
      }>;
    };

    if (!csvFileName || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ message: 'csvFileName and items are required' });

    const [session] = await db
      .select()
      .from(orderImportSessions)
      .where(and(eq(orderImportSessions.id, id), eq(orderImportSessions.isDeleted, false)));

    if (!session) return res.status(404).json({ message: 'Session not found' });

    await db.delete(orderImportItems).where(eq(orderImportItems.sessionId, id));

    const rows = items.map((item) => ({
      sessionId: id,
      plant: session.plant,
      barcode: item.barcode || null,
      itemName: item.itemName || null,
      sapCode: item.sapCode || null,
      quantity: item.quantity ?? 0,
      expectedPallets: item.expectedPallets ?? null,
    }));

    await db.insert(orderImportItems).values(rows);

    const [updated] = await db
      .update(orderImportSessions)
      .set({ csvFileName, rowCount: rows.length })
      .where(eq(orderImportSessions.id, id))
      .returning();

    res.json({ success: true, session: updated, rowCount: rows.length });

    broadcastOrderImportUpdate();
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Update failed' });
  }
});

// DELETE /api/order-import/sessions/:id
router.delete('/order-import/sessions/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    await db
      .update(orderImportSessions)
      .set({ isDeleted: true, deletedAt: new Date(), scanStatus: 'available' })
      .where(eq(orderImportSessions.id, id));

    res.json({ success: true });

    broadcastOrderImportUpdate();
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Delete failed' });
  }
});

// GET /api/order-import/master-view?date=YYYY-MM-DD&plant=X
// Returns all items from all sessions uploaded on the given date, merged in upload order.
router.get('/order-import/master-view', async (req: Request, res: Response) => {
  try {
    const dateStr = String(req.query.date ?? '');
    if (!dateStr) return res.status(400).json({ message: 'date is required (YYYY-MM-DD)' });

    const conditions = [
      eq(orderImportSessions.isDeleted, false),
      sql`(${orderImportSessions.createdAt})::date = ${dateStr}::date`,
    ];

    if (req.query.plant) {
      conditions.push(sql`LOWER(${orderImportSessions.plant}) = LOWER(${String(req.query.plant)})`);
    }

    const where = and(...(conditions as any[]));

    // Fetch sessions ordered by createdAt ASC to preserve upload sequence
    const sessions = await db
      .select({
        id:             orderImportSessions.id,
        plant:          orderImportSessions.plant,
        csvFileName:    orderImportSessions.csvFileName,
        rowCount:       orderImportSessions.rowCount,
        importedByCode: orderImportSessions.importedByCode,
        importedByName: users.name,
        createdAt:      orderImportSessions.createdAt,
        scanStatus:     orderImportSessions.scanStatus,
      })
      .from(orderImportSessions)
      .leftJoin(users, eq(orderImportSessions.importedByCode, users.userCode))
      .where(where)
      .orderBy(orderImportSessions.createdAt, orderImportSessions.id); // stable ASC = upload order

    if (sessions.length === 0) {
      return res.json({ date: dateStr, totalFiles: 0, totalRows: 0, files: [] });
    }

    const sessionIds = sessions.map((s) => s.id);

    // Use a correlated subquery for scan totals so we always get exactly one row
    // per import item — a plain LEFT JOIN on order_import_item_id would produce
    // duplicate rows when the same item appears in multiple scan sessions (e.g.
    // after re-activation), breaking the grouped result.
    const { rows: rawItems } = await pool.query(`
      SELECT
        oi.id,
        oi.session_id   AS "sessionId",
        oi.barcode,
        oi.item_name    AS "itemName",
        oi.sap_code     AS "sapCode",
        oi.quantity,
        oi.expected_pallets AS "expectedPallets",
        (SELECT total_scanned_qty FROM order_scan_items osi
          WHERE osi.order_import_item_id = oi.id
             OR (osi.order_import_item_id IS NULL
                 AND osi.session_id = oi.session_id
                 AND osi.barcode IS NOT DISTINCT FROM oi.barcode)
          ORDER BY osi.id DESC LIMIT 1)          AS "scannedQty",
        (SELECT status FROM order_scan_items osi
          WHERE osi.order_import_item_id = oi.id
             OR (osi.order_import_item_id IS NULL
                 AND osi.session_id = oi.session_id
                 AND osi.barcode IS NOT DISTINCT FROM oi.barcode)
          ORDER BY osi.id DESC LIMIT 1)          AS "scanStatus"
      FROM order_import_items oi
      WHERE oi.session_id = ANY($1::int[])
      ORDER BY oi.session_id, oi.id
    `, [sessionIds]);
    const allItems: Array<{
      id: number; sessionId: number; barcode: string | null; itemName: string | null;
      sapCode: string | null; quantity: number | null; expectedPallets: number | null;
      scannedQty: number | null; scanStatus: string | null;
    }> = rawItems;

    // Group items by sessionId
    const itemsBySession = new Map<number, typeof allItems>();
    for (const item of allItems) {
      if (!itemsBySession.has(item.sessionId)) itemsBySession.set(item.sessionId, []);
      itemsBySession.get(item.sessionId)!.push(item);
    }

    const files = sessions.map((s) => ({
      sessionId:    s.id,
      csvFileName:  s.csvFileName,
      rowCount:     s.rowCount,
      uploadedAt:   s.createdAt,
      uploadedBy:   s.importedByName ?? s.importedByCode ?? 'Unknown',
      plant:        s.plant,
      scanStatus:   s.scanStatus,
      items:        itemsBySession.get(s.id) ?? [],
    }));

    const totalRows = files.reduce((sum, f) => sum + f.items.length, 0);

    res.json({ date: dateStr, totalFiles: files.length, totalRows, files });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Master view failed' });
  }
});

export default router;
