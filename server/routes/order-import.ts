import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { orderImportSessions, orderImportItems, users } from '../../shared/schema';
import { eq, desc, and, sql } from 'drizzle-orm';

const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const role = ((req.user as any)?.role ?? '').toLowerCase();
  if (!['admin', 'super-admin', 'billing'].includes(role))
    return res.status(403).json({ message: 'Access required' });
  next();
}

router.use('/order-import', requireAdmin);

// GET /api/order-import/sessions?page=1&pageSize=10&date=YYYY-MM-DD
router.get('/order-import/sessions', async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page     ?? '1')));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '10'))));

    // DB stores timestamps in local server time (IST) without timezone info.
    // Compare the date portion directly — no timezone conversion needed.
    const dateCondition = req.query.date
      ? sql`(${orderImportSessions.createdAt})::date = ${String(req.query.date)}::date`
      : null;

    const conditions = [
      eq(orderImportSessions.isDeleted, false),
      dateCondition,
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

// DELETE /api/order-import/sessions/:id
// Soft-delete: marks the session as deleted so it disappears from the import list
// but all related scan_items and scan_events are preserved for history and reports.
router.delete('/order-import/sessions/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    await db
      .update(orderImportSessions)
      .set({ isDeleted: true, deletedAt: new Date() })
      .where(eq(orderImportSessions.id, id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Delete failed' });
  }
});

export default router;
