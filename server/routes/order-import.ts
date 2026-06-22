import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { orderImportSessions, orderImportItems, users } from '../../shared/schema';
import { eq, desc, and, sql } from 'drizzle-orm';

const router = Router();

// ── SSE client registry ───────────────────────────────────────────────────────
// Every connected admin browser holds an open SSE connection here.
// After any session mutation we call broadcastOrderImportUpdate() and every
// browser immediately refetches — zero-latency sync without relying on polls.
const sseClients = new Set<Response>();

export function broadcastOrderImportUpdate(): void {
  const frame = 'data: update\n\n';
  sseClients.forEach((res) => {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  });
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const role = ((req.user as any)?.role ?? '').toLowerCase();
  if (!['admin', 'super-admin', 'billing'].includes(role))
    return res.status(403).json({ message: 'Access required' });
  next();
}

router.use('/order-import', requireAdmin);

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

  sseClients.add(res);

  // Heartbeat every 25 s keeps the connection alive through reverse proxies
  // that close idle TCP connections (IIS ARR default = 30 s).
  const heartbeat = setInterval(() => {
    try { res.write(':ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25_000);

  req.on('close', () => {
    sseClients.delete(res);
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

    res.status(201).json({ success: true, session, rowCount: rows.length });

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
    const items = await db
      .select()
      .from(orderImportItems)
      .where(eq(orderImportItems.sessionId, id))
      .orderBy(orderImportItems.id);
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

export default router;
