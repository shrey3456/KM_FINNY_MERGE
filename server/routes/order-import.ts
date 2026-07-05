import { Router, Request, Response, NextFunction } from 'express';
import { db, pool } from '../db';
import { orderImportSessions, orderImportItems, users } from '../../shared/schema';
import { eq, desc, and, sql, inArray, asc } from 'drizzle-orm';
import { addSseClient, removeSseClient, broadcastOrderImportUpdate } from '../lib/importEvents';
import { seedAndActivateSession } from './order-scan';
import { computeGroupReport, resolveGroupId, computePartReport } from '../lib/orderGroupReport';

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
        receivingSessionId: orderImportSessions.receivingSessionId,
        partIndex:      orderImportSessions.partIndex,
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
    const { plant, csvFileName, items, receivingSessionId, partIndex } = req.body as {
      plant: string;
      csvFileName: string;
      items: Array<{
        barcode?: string;
        itemName?: string;
        sapCode?: string;
        quantity?: number;
        expectedPallets?: number;
      }>;
      // Present only for a FIFO-batch upload: all parts of one multi-CSV upload share the
      // same receivingSessionId (Part 1's own id), ordered by partIndex.
      receivingSessionId?: number | null;
      partIndex?: number | null;
    };

    if (!plant || !csvFileName || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ message: 'plant, csvFileName and items are required' });

    const userCode = (req.user as any)?.userCode ?? null;

    let [session] = await db
      .insert(orderImportSessions)
      .values({
        plant, csvFileName, rowCount: items.length, importedByCode: userCode,
        receivingSessionId: receivingSessionId ?? null,
        partIndex: partIndex ?? null,
      })
      .returning();

    // Part 1 of a new FIFO batch doesn't know its group id until after insert — the
    // group id IS Part 1's own id. The client passes partIndex:1 with no
    // receivingSessionId for the first file, then reads back receivingSessionId here
    // to pass along as the group id for parts 2, 3, ...
    if (partIndex === 1 && !receivingSessionId) {
      [session] = await db.update(orderImportSessions)
        .set({ receivingSessionId: session.id })
        .where(eq(orderImportSessions.id, session.id))
        .returning();
    }
    const effectiveGroupId = session.receivingSessionId;

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
    // If nothing is currently being scanned, immediately make this freshly-uploaded
    // CSV the active scan session so dispatch can start scanning without anyone
    // manually picking it. Scoped to the FIFO group when this is a batch part (so
    // Part 2/3 don't jump ahead of Part 1), otherwise scoped to the whole plant as
    // before. If something is already active, leave it alone — completion
    // auto-progression will pick this one up later in turn.
    let activated = false;
    const activeConditions = effectiveGroupId
      ? [
          eq(orderImportSessions.receivingSessionId, effectiveGroupId),
          eq(orderImportSessions.scanStatus, 'active'),
          eq(orderImportSessions.isDeleted, false),
        ]
      : [
          sql`LOWER(${orderImportSessions.plant}) = LOWER(${plant})`,
          eq(orderImportSessions.scanStatus, 'active'),
          eq(orderImportSessions.isDeleted, false),
        ];
    const activeForPlant = await db.select({ id: orderImportSessions.id })
      .from(orderImportSessions)
      .where(and(...activeConditions))
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

// GET /api/order-import/sessions/:id/group-report
// Per-part + consolidated FIFO-adjusted report for the whole batch a part belongs to.
// :id can be any part in the group. 404 if the part isn't part of a FIFO batch upload.
router.get('/order-import/sessions/:id/group-report', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

    const groupId = await resolveGroupId(id);
    if (!groupId) return res.status(404).json({ message: 'This session is not part of a FIFO batch upload' });

    const report = await computeGroupReport(groupId);
    if (!report) return res.status(404).json({ message: 'Group not found' });

    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to build group report' });
  }
});

// GET /api/order-import/sessions/:id/part-report
// Single-CSV report — downloadable as soon as THAT one part is completed, no need to wait
// for the whole FIFO group. Includes cross-part adjustments when the CSV is part of a group.
router.get('/order-import/sessions/:id/part-report', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

    const report = await computePartReport(id);
    if (!report) return res.status(404).json({ message: 'Session not found' });

    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to build part report' });
  }
});

// GET /api/order-import/sessions/:id/scan-activity
// Full scan history for one CSV/part — every scan event (who, when, qty, extra, STV).
// ?scope=group returns the whole FIFO group's events, each tagged with its Part # + file.
router.get('/order-import/sessions/:id/scan-activity', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

    const scope = String(req.query.scope ?? 'part');

    // Resolve which sessions to include + a Part#/file label per session.
    let sessionIds: number[] = [id];
    const labelBySession = new Map<number, { partIndex: number | null; csvFileName: string }>();

    if (scope === 'group') {
      const groupId = await resolveGroupId(id) ?? id; // fall back to the session itself
      const parts = await db
        .select({ id: orderImportSessions.id, partIndex: orderImportSessions.partIndex, csvFileName: orderImportSessions.csvFileName })
        .from(orderImportSessions)
        .where(and(eq(orderImportSessions.receivingSessionId, groupId), eq(orderImportSessions.isDeleted, false)))
        .orderBy(asc(orderImportSessions.partIndex), asc(orderImportSessions.id));
      if (parts.length > 0) {
        sessionIds = parts.map((p) => p.id);
        parts.forEach((p) => labelBySession.set(p.id, { partIndex: p.partIndex, csvFileName: p.csvFileName }));
      }
    }
    if (labelBySession.size === 0) {
      const [self] = await db
        .select({ id: orderImportSessions.id, partIndex: orderImportSessions.partIndex, csvFileName: orderImportSessions.csvFileName })
        .from(orderImportSessions)
        .where(eq(orderImportSessions.id, id));
      if (self) { sessionIds = [self.id]; labelBySession.set(self.id, { partIndex: self.partIndex, csvFileName: self.csvFileName }); }
    }

    const { rows: events } = await pool.query(
      `SELECT session_id AS "sessionId", barcode, item_name AS "itemName",
              pallets, loose_qty AS "looseQty", total_qty AS "totalQty",
              is_extra AS "isExtra", stv, scanned_by_code AS "scannedByCode",
              scanned_by_name AS "scannedByName", scanned_at AS "scannedAt"
       FROM order_scan_events
       WHERE session_id = ANY($1::int[])
       ORDER BY scanned_at ASC, id ASC`,
      [sessionIds],
    );

    const withLabels = events.map((e: any) => ({
      ...e,
      partIndex: labelBySession.get(e.sessionId)?.partIndex ?? null,
      csvFileName: labelBySession.get(e.sessionId)?.csvFileName ?? null,
    }));

    res.json({ scope, totalEvents: withLabels.length, events: withLabels });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch scan activity' });
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
//   or  /api/order-import/master-view?sessionIds=1,2,3
// Returns all items from all matching sessions, merged in upload order. sessionIds scopes
// the view to exactly the given sessions (e.g. one just-uploaded batch) instead of every
// session for a plant/day — used by OrderImport's batch-upload Master View.
router.get('/order-import/master-view', async (req: Request, res: Response) => {
  try {
    const dateStr = String(req.query.date ?? '');
    const sessionIdsParam = String(req.query.sessionIds ?? '').trim();

    let conditions: any[];
    if (sessionIdsParam) {
      const ids = sessionIdsParam.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      if (ids.length === 0) return res.status(400).json({ message: 'sessionIds must be a comma-separated list of numbers' });
      conditions = [eq(orderImportSessions.isDeleted, false), inArray(orderImportSessions.id, ids)];
    } else if (dateStr) {
      conditions = [
        eq(orderImportSessions.isDeleted, false),
        sql`(${orderImportSessions.createdAt})::date = ${dateStr}::date`,
      ];
      if (req.query.plant) {
        conditions.push(sql`LOWER(${orderImportSessions.plant}) = LOWER(${String(req.query.plant)})`);
      }
    } else {
      return res.status(400).json({ message: 'date or sessionIds is required' });
    }

    const where = and(...conditions);

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
      scannedQty: number | null; scanStatus: string | null; isExtra?: boolean;
    }> = rawItems;

    // Group items by sessionId
    const itemsBySession = new Map<number, typeof allItems>();
    for (const item of allItems) {
      if (!itemsBySession.has(item.sessionId)) itemsBySession.set(item.sessionId, []);
      itemsBySession.get(item.sessionId)!.push(item);
    }

    // Fold in "extra" scans — barcodes scanned during one of these sessions that were
    // never part of that session's CSV (order_import_items has no row for them). These
    // only exist as order_scan_events rows (scan_item_id is null, is_extra = true), so
    // without this they'd be invisible in Master View even though real stock arrived.
    // Grouped/summed per barcode in case the same extra barcode was scanned more than once.
    const { rows: extraRows } = await pool.query(`
      SELECT
        ose.session_id          AS "sessionId",
        ose.barcode,
        MAX(ose.item_name)      AS "itemName",
        SUM(ose.total_qty)::int AS "scannedQty"
      FROM order_scan_events ose
      WHERE ose.session_id = ANY($1::int[])
        AND ose.is_extra = true
        AND ose.barcode IS NOT NULL
      GROUP BY ose.session_id, ose.barcode
    `, [sessionIds]);

    extraRows.forEach((ex: any, idx: number) => {
      const list = itemsBySession.get(ex.sessionId) ?? [];
      list.push({
        id: -1 - idx,
        sessionId: ex.sessionId,
        barcode: ex.barcode,
        itemName: ex.itemName,
        sapCode: null,
        quantity: 0,
        expectedPallets: null,
        scannedQty: ex.scannedQty,
        scanStatus: 'extra',
        isExtra: true,
      });
      itemsBySession.set(ex.sessionId, list);
    });

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
