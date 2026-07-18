import { Router, Request, Response, NextFunction } from 'express';
import { db, pool } from '../db';
import { orderImportSessions, orderImportItems, users } from '../../shared/schema';
import { eq, desc, and, sql, inArray, asc } from 'drizzle-orm';
import { addSseClient, removeSseClient, broadcastOrderImportUpdate } from '../lib/importEvents';
import { seedAndActivateSession, seedSessionItems, sweepStaleCompletions, getPlantFilter, broadcastSessionDeleted, autoActivateNextInScope } from './order-scan';
import { computeGroupReport, resolveGroupId, computePartReport, reconcileCredits } from '../lib/orderGroupReport';
import { remapDeletedSessionScans } from '../lib/orderScanRemap';
import { storage } from '../storage';

export { broadcastOrderImportUpdate };

const router = Router();

const IMPORT_ADMIN_ROLES = ['admin', 'super-admin', 'billing'];

// Full read/write access — uploading, editing, deleting import sessions. Admin/billing only.
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const role = ((req.user as any)?.role ?? '').toLowerCase();
  if (!IMPORT_ADMIN_ROLES.includes(role))
    return res.status(403).json({ message: 'Access required' });
  next();
}

// Write access to the Order Import page's own actions (upload, delete) — admin/billing
// always pass (unchanged from before), OR any user admin has explicitly granted write
// access to this specific page via pageWriteAccess on the User Management page. This is
// additive: it never removes access anyone already had, only opens a new path for
// non-admin users who've been granted write on "order-import" specifically.
function requireOrderImportWrite(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const role = ((req.user as any)?.role ?? '').toLowerCase();
  if (IMPORT_ADMIN_ROLES.includes(role)) return next();
  let writable: string[] = [];
  try { writable = JSON.parse((req.user as any)?.pageWriteAccess || '[]'); } catch { /* default [] */ }
  if (writable.includes('order-import')) return next();
  return res.status(403).json({ message: 'Write access required for Order Import' });
}

// Read-only access to Master View / Separate CSVs — admin/billing see everything; a
// dispatch user (role/department resolves to a plant via getPlantFilter) can view too, but
// every route using this middleware forces the query to THAT plant only, ignoring/overriding
// whatever ?plant= was requested, so dispatch can never read another plant's data. Anyone
// authenticated but with no resolvable admin role or plant is denied.
function requireImportViewAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const role = ((req.user as any)?.role ?? '').toLowerCase();
  if (IMPORT_ADMIN_ROLES.includes(role)) {
    (req as any).importViewPlant = null; // null = no forced scope, sees all plants
    return next();
  }
  const plantFilter = getPlantFilter(req.user);
  if (plantFilter) {
    (req as any).importViewPlant = plantFilter;
    return next();
  }
  return res.status(403).json({ message: 'Access required' });
}

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
router.get('/order-import/stream', requireAdmin, (req: Request, res: Response) => {
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
// Admin/billing may filter by any plant via ?plant=; a dispatch user gets that param
// ignored and forced to their own plant (importViewPlant, set by requireImportViewAccess).
router.get('/order-import/sessions', requireImportViewAccess, async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page     ?? '1')));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '10'))));

    const dateCondition = req.query.date
      ? sql`(${orderImportSessions.createdAt})::date = ${String(req.query.date)}::date`
      : null;

    const forcedPlant = (req as any).importViewPlant as string | null;
    const plantCondition = forcedPlant
      ? sql`LOWER(${orderImportSessions.plant}) = LOWER(${forcedPlant})`
      : req.query.plant
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
router.post('/order-import/sessions', requireOrderImportWrite, async (req: Request, res: Response) => {
  try {
    const { plant, csvFileName, items, orderDate } = req.body as {
      plant: string;
      csvFileName: string;
      items: Array<{
        barcode?: string;
        itemName?: string;
        sapCode?: string;
        quantity?: number;
        expectedPallets?: number;
      }>;
      // "Order Date" chosen at upload (YYYY-MM-DD). FIFO grouping is derived from it:
      // every CSV with the same plant + orderDate is one group, in upload order.
      orderDate?: string | null;
    };

    if (!plant || !csvFileName || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ message: 'plant, csvFileName and items are required' });

    const userCode = (req.user as any)?.userCode ?? null;
    const normOrderDate = orderDate && String(orderDate).trim() ? String(orderDate).trim() : null;

    // ── Delete-with-rollback replacement: reclaim a deleted session's slot ─────────────────
    // If a CSV was deleted for this exact (plant, orderDate) slot and no replacement has
    // claimed it yet, THIS upload is that replacement — it reclaims the deleted session's
    // group id + partIndex (instead of being appended after the surviving parts), and its
    // scan history gets carried forward below via remapDeletedSessionScans. Oldest unresolved
    // deletion first, so multiple wrong uploads/deletes in a row resolve in order.
    const [replacementFor] = await db
      .select({
        id: orderImportSessions.id,
        receivingSessionId: orderImportSessions.receivingSessionId,
        partIndex: orderImportSessions.partIndex,
        csvFileName: orderImportSessions.csvFileName,
      })
      .from(orderImportSessions)
      .where(and(
        sql`LOWER(${orderImportSessions.plant}) = LOWER(${plant})`,
        sql`${orderImportSessions.orderDate} IS NOT DISTINCT FROM ${normOrderDate}`,
        eq(orderImportSessions.isDeleted, true),
        sql`${orderImportSessions.remappedToSessionId} IS NULL`,
      ))
      .orderBy(asc(orderImportSessions.deletedAt))
      .limit(1);

    // ── Auto-group by (plant + order date) ───────────────────────────────────────
    // Look for an existing non-deleted group for this plant + order date. If found,
    // join it as the next part; otherwise this CSV starts a new group (becomes Part 1
    // and self-assigns its own id as the group id after insert).
    let effectiveGroupId: number | null = null;
    let computedPartIndex = 1;
    let joinedExistingGroup = false;
    if (replacementFor) {
      effectiveGroupId = replacementFor.receivingSessionId;
      computedPartIndex = replacementFor.partIndex ?? 1;
    } else if (normOrderDate) {
      // Include DELETED sessions here (not just active ones) so a permanently-discarded part's
      // slot number is RETIRED, never reused: a fresh upload always gets max(partIndex)+1 over
      // EVERY session that ever existed in this (plant, orderDate) group. Without this, two
      // wrong-then-discard cases misbehave — discarding the highest part and re-uploading would
      // hand back that same part number (max over just the survivors reproduces it), and
      // discarding the only part would restart numbering at 1. A replace-delete never reaches
      // here (it's reclaimed above via `replacementFor`), so this only affects normal appends
      // and post-discard uploads, which is exactly where we want strictly-increasing numbering.
      const existing = await db
        .select({ id: orderImportSessions.id, receivingSessionId: orderImportSessions.receivingSessionId, partIndex: orderImportSessions.partIndex })
        .from(orderImportSessions)
        .where(and(
          sql`LOWER(${orderImportSessions.plant}) = LOWER(${plant})`,
          eq(orderImportSessions.orderDate, normOrderDate),
        ))
        .orderBy(asc(orderImportSessions.partIndex), asc(orderImportSessions.id));
      if (existing.length > 0) {
        effectiveGroupId = existing[0].receivingSessionId ?? existing[0].id;
        computedPartIndex = Math.max(...existing.map((e) => e.partIndex ?? 0)) + 1;
        joinedExistingGroup = true;
      }
    }

    let [session] = await db
      .insert(orderImportSessions)
      .values({
        plant, csvFileName, rowCount: items.length, importedByCode: userCode,
        orderDate: normOrderDate,
        receivingSessionId: effectiveGroupId,
        partIndex: computedPartIndex,
      })
      .returning();

    // New group's Part 1 doesn't know its group id until after insert — the group id IS
    // Part 1's own id.
    if (!effectiveGroupId) {
      [session] = await db.update(orderImportSessions)
        .set({ receivingSessionId: session.id })
        .where(eq(orderImportSessions.id, session.id))
        .returning();
      effectiveGroupId = session.id;
    }

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

    // ── Delete-with-rollback replacement: carry D's scan history forward onto S ────────────
    // Runs BEFORE seeding below, so seedSessionItems' per-item idempotency correctly skips
    // the barcodes remap already created order_scan_items rows for.
    let remapSummary: Awaited<ReturnType<typeof remapDeletedSessionScans>> | null = null;
    if (replacementFor) {
      const remapClient = await pool.connect();
      try {
        await remapClient.query('BEGIN');
        remapSummary = await remapDeletedSessionScans(remapClient, replacementFor.id, session.id);
        await remapClient.query('COMMIT');
      } catch (err) {
        await remapClient.query('ROLLBACK');
        throw err;
      } finally {
        remapClient.release();
      }
      session = { ...session, replacesSessionId: replacementFor.id } as typeof session;
      await storage.logActivity({
        pageName: 'OrderImport',
        action: 'remap-replacement',
        entityType: 'orderImportSession',
        entityId: session.id,
        userCode,
        userName: (req.user as any)?.name ?? null,
        details: {
          replacesSessionId: replacementFor.id,
          replacesCsvFileName: replacementFor.csvFileName,
          ...remapSummary,
        },
      });
      console.log(`[order-import] session ${session.id} (${csvFileName}) auto-linked as replacement for deleted session ${replacementFor.id} (${replacementFor.csvFileName}) — ${remapSummary?.itemsCarriedForward ?? 0} scanned item(s) carried forward`);
    }

    // Seed order_scan_items immediately, regardless of activation state — every part in a
    // FIFO group is scannable from the moment it's uploaded, since sequential cross-part
    // search (Master View scanning) needs to be able to check every part's CSV, not just
    // whichever one is currently flagged "active".
    await seedSessionItems(session.id, plant);

    // If this CSV just joined an EXISTING group, whichever part was previously "last" may
    // have been fully scanned already but deliberately left open (Auto Complete's last-part
    // rule) — and since it has nothing left to scan, nothing would ever re-check it again on
    // its own. Sweep the group now that a new last part exists, so that old part completes
    // immediately instead of sitting stuck. No-op if Auto Complete is off for this plant, or
    // if nothing in the group actually qualifies.
    if (joinedExistingGroup && effectiveGroupId) {
      await sweepStaleCompletions(effectiveGroupId, plant, userCode);

      // An earlier part may have already completed — and had its leftover extra checked for
      // credit opportunities — BEFORE this new part existed. reconcileCredits only ever runs
      // once, at the moment a part completes, so an already-completed part's un-consumed
      // extra would otherwise never get a second chance to credit a part that didn't exist
      // yet. Re-run it now against every already-completed part in the group so this new
      // part is considered too.
      const { rows: completedParts } = await pool.query(
        `SELECT id FROM order_import_sessions
         WHERE receiving_session_id = $1 AND is_deleted = false AND scan_status = 'completed'`,
        [effectiveGroupId],
      );
      if (completedParts.length > 0) {
        const creditClient = await pool.connect();
        try {
          await creditClient.query('BEGIN');
          for (const p of completedParts) {
            await reconcileCredits(creditClient, p.id, effectiveGroupId);
          }
          await creditClient.query('COMMIT');
        } catch (e) {
          await creditClient.query('ROLLBACK');
          console.error('[order-import] credit reconciliation against new part failed:', e);
        } finally {
          creditClient.release();
        }
      }
    }

    // ── Auto-activate ──────────────────────────────────────────────────────────
    // "Active" now only marks which part is shown as the primary/front one in the UI —
    // it no longer gates whether a part's items exist or are scannable (see seeding above).
    // The first CSV of a date-group goes active immediately; later same-date parts stay
    // 'available' and auto-advance (by partIndex, group-scoped) as each part completes.
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
      activated = await seedAndActivateSession(session.id, userCode);
      if (activated) {
        console.log(`[order-import] auto-activated session ${session.id} (${csvFileName}) part ${computedPartIndex} of group ${effectiveGroupId} — plant ${plant} idle`);
      } else {
        console.log(`[order-import] session ${session.id} lost the activation race for plant ${plant} — left 'available'`);
      }
    } else {
      console.log(`[order-import] session ${session.id} left 'available' — plant ${plant} already has an active session`);
    }

    res.status(201).json({
      success: true, session, rowCount: rows.length, activated,
      replacesSessionId: replacementFor?.id ?? null,
      remapSummary,
    });

    // Push change event AFTER responding so client response is never delayed
    broadcastOrderImportUpdate();
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Import failed' });
  }
});

// GET /api/order-import/sessions/:id/items
router.get('/order-import/sessions/:id/items', requireImportViewAccess, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);

    // A dispatch user (importViewPlant set) may only read items for a session that
    // belongs to their own plant — this route has no ?plant= param to force, so verify
    // by looking the session up first.
    const forcedPlant = (req as any).importViewPlant as string | null;
    if (forcedPlant) {
      const [session] = await db.select({ plant: orderImportSessions.plant })
        .from(orderImportSessions)
        .where(eq(orderImportSessions.id, id));
      if (!session || session.plant.toLowerCase() !== forcedPlant.toLowerCase()) {
        return res.status(403).json({ message: 'Access required' });
      }
    }

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
router.get('/order-import/sessions/:id/group-report', requireImportViewAccess, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

    // Same plant-ownership check as GET .../items — a dispatch user may only pull the
    // report for a group whose parts belong to their own plant.
    const forcedPlant = (req as any).importViewPlant as string | null;
    if (forcedPlant) {
      const [session] = await db.select({ plant: orderImportSessions.plant })
        .from(orderImportSessions)
        .where(eq(orderImportSessions.id, id));
      if (!session || session.plant.toLowerCase() !== forcedPlant.toLowerCase()) {
        return res.status(403).json({ message: 'Access required' });
      }
    }

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
router.get('/order-import/sessions/:id/part-report', requireImportViewAccess, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

    const forcedPlant = (req as any).importViewPlant as string | null;
    if (forcedPlant) {
      const [session] = await db.select({ plant: orderImportSessions.plant })
        .from(orderImportSessions)
        .where(eq(orderImportSessions.id, id));
      if (!session || session.plant.toLowerCase() !== forcedPlant.toLowerCase()) {
        return res.status(403).json({ message: 'Access required' });
      }
    }

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
router.get('/order-import/sessions/:id/scan-activity', requireImportViewAccess, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

    const forcedPlant = (req as any).importViewPlant as string | null;
    if (forcedPlant) {
      const [session] = await db.select({ plant: orderImportSessions.plant })
        .from(orderImportSessions)
        .where(eq(orderImportSessions.id, id));
      if (!session || session.plant.toLowerCase() !== forcedPlant.toLowerCase()) {
        return res.status(403).json({ message: 'Access required' });
      }
    }

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
router.put('/order-import/sessions/:id', requireAdmin, async (req: Request, res: Response) => {
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

// Shared by the delete-preview endpoint and the actual DELETE handler below, so the two
// never drift on what counts as "scanned"/"extra" for this session.
async function getSessionScanCounts(
  queryable: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> },
  sessionId: number,
) {
  const { rows: itemRows } = await queryable.query(
    `SELECT COUNT(*)::int AS "scannedItemCount", COALESCE(SUM(total_scanned_qty), 0)::int AS "scannedQtyTotal"
     FROM order_scan_items WHERE session_id = $1 AND total_scanned_qty > 0`,
    [sessionId],
  );
  const { rows: extraRows } = await queryable.query(
    `SELECT COALESCE(SUM(total_qty), 0)::int AS "extraQtyTotal"
     FROM order_scan_events WHERE session_id = $1 AND is_extra = true AND voided IS NOT TRUE`,
    [sessionId],
  );
  return {
    scannedItemCount: itemRows[0]?.scannedItemCount ?? 0,
    scannedQtyTotal: itemRows[0]?.scannedQtyTotal ?? 0,
    extraQtyTotal: extraRows[0]?.extraQtyTotal ?? 0,
  };
}

// GET /api/order-import/sessions/:id/delete-preview — Admin-only. Powers the delete
// confirmation dialog's "N items already scanned against this file..." warning.
router.get('/order-import/sessions/:id/delete-preview', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: sessRows } = await pool.query(
      `SELECT id FROM order_import_sessions WHERE id = $1`,
      [id],
    );
    if (!sessRows[0]) return res.status(404).json({ message: 'Session not found' });

    // "stockApplied" = did this session's scans actually move stock? In the live-scan model
    // every scan applies its own delta immediately (applyLiveScanStock) WITHOUT ever setting
    // stock_applied_at, so we must detect stock from the presence of non-voided received
    // events, not from stock_applied_at (which is null for a normally-scanned session).
    const { rows: stockRows } = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM order_scan_events
         WHERE session_id = $1 AND barcode IS NOT NULL AND voided IS NOT TRUE AND total_qty <> 0
       ) AS "stockApplied"`,
      [id],
    );

    const counts = await getSessionScanCounts(pool, id);
    res.json({ ...counts, stockApplied: stockRows[0]?.stockApplied ?? false });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to compute delete preview' });
  }
});

// DELETE /api/order-import/sessions/:id?mode=replace|discard — Admin-only. The admin states
// intent at delete time (the "will you re-upload a corrected version?" dialog):
//
//   mode=replace (default): soft-delete only. Scan items/events stay pointed at this
//     (now-deleted) session and stock is LEFT in place — the physical boxes are real and get
//     carried forward onto whichever corrected CSV is next uploaded into the same
//     (plant, orderDate) slot (see remapDeletedSessionScans, invoked from the upload handler).
//     Because stock is never reversed here, remap never has to re-add it — the boxes simply
//     stay counted through the delete→re-upload cycle.
//
//   mode=discard: the admin does NOT want this CSV at all. Reverse the stock its scans moved,
//     void its scan events, reset its scan items to pending (so it leaves Master View/reports),
//     and mark it resolved (remapped_to_session_id = self) so the NEXT upload is treated as a
//     brand-new file rather than inheriting this deleted CSV's slot and scans.
router.delete('/order-import/sessions/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const userCode = (req.user as any)?.userCode ?? null;
  const userName = (req.user as any)?.name ?? null;
  const discard = String(req.query.mode ?? 'replace') === 'discard';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sessResult = await client.query(
      `SELECT * FROM order_import_sessions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const session = sessResult.rows[0];
    if (!session) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Session not found' });
    }

    const scanCounts = await getSessionScanCounts(client, id);

    // Stock reversal + scan teardown only happen on a permanent (discard) delete — a replace
    // delete deliberately leaves both intact for the remap to carry forward.
    const stockReversed: Array<{ barcode: string; qty: number; extraQty: number }> = [];
    if (discard) {
      // Reverse stock this session's scans actually moved. Driven off the presence of received
      // events, NOT stock_applied_at: live scanning (applyLiveScanStock) applies stock per scan
      // without ever setting stock_applied_at, so gating on that flag would skip the reversal
      // entirely for a normally-scanned session.
      const { rows: received } = await client.query(
        `SELECT MAX(barcode) AS barcode,
                SUM(total_qty)::int AS qty,
                COALESCE(SUM(total_qty) FILTER (WHERE is_extra), 0)::int AS extra_qty
         FROM order_scan_events
         WHERE session_id = $1 AND barcode IS NOT NULL AND voided IS NOT TRUE
         GROUP BY LOWER(barcode)
         HAVING SUM(total_qty) <> 0`,
        [id],
      );

      for (const r of received) {
        // Lock the plant-stock row and clamp against its CURRENT value before writing — stock
        // may have moved (dispatch, another session) since this session's apply, so blindly
        // subtracting r.qty with a GREATEST(0, ...) floor would silently remove less than the
        // ledger row claims. Computing the actual delta up front keeps the negative
        // stock_movements row truthful (what was actually reversed, not what was requested).
        const { rows: plantRows } = await client.query(
          `SELECT in_stock, extra_qty FROM product_plant_stock WHERE barcode = $1 AND plant = $2 FOR UPDATE`,
          [r.barcode, session.plant],
        );
        const actualQty = Math.min(r.qty, Number(plantRows[0]?.in_stock ?? 0));
        const actualExtraQty = Math.min(r.extra_qty, Number(plantRows[0]?.extra_qty ?? 0));
        if (actualQty <= 0 && actualExtraQty <= 0) continue;

        await client.query(
          `UPDATE products SET in_stock = GREATEST(0, COALESCE(in_stock, 0) - $1) WHERE LOWER(barcode) = LOWER($2)`,
          [actualQty, r.barcode],
        );
        if (plantRows[0]) {
          await client.query(
            `UPDATE product_plant_stock
             SET in_stock = in_stock - $1, extra_qty = extra_qty - $2, updated_at = NOW()
             WHERE barcode = $3 AND plant = $4`,
            [actualQty, actualExtraQty, r.barcode, session.plant],
          );
        }
        await client.query(
          `INSERT INTO stock_movements (barcode, plant, qty, extra_qty, type, reason, session_id, created_at)
           VALUES ($1, $2, $3, $4, 'adjust', 'Order CSV deleted — rollback', $5, NOW())`,
          [r.barcode, session.plant, -actualQty, -actualExtraQty, id],
        );
        stockReversed.push({ barcode: r.barcode, qty: actualQty, extraQty: actualExtraQty });
      }

      // Tear down the scan work so it leaves Master View/reports and can never be carried
      // forward: void the events and reset the items to pending.
      await client.query(
        `UPDATE order_scan_events SET voided = true WHERE session_id = $1 AND voided IS NOT TRUE`,
        [id],
      );
      await client.query(
        `UPDATE order_scan_items
         SET total_scanned_qty = 0, scanned_pallets = 0, scanned_loose_qty = 0, status = 'pending'
         WHERE session_id = $1`,
        [id],
      );
    }

    // Raw pg (not Drizzle's .update().set()) so deleted_at gets the same IST wall-clock
    // convention as every other timestamp write in this app — see the matching comment in
    // order-scan.ts's /complete for why Drizzle's own serialization doesn't match.
    //
    // On discard, mark the session resolved by pointing remapped_to_session_id at itself: the
    // upload replacement lookup and remapDeletedSessionScans both treat a non-null
    // remapped_to_session_id as "already resolved, skip", so this deleted CSV can never be
    // picked up as a remap target — the next upload for this slot is a brand-new file.
    await client.query(
      `UPDATE order_import_sessions
       SET is_deleted = true, deleted_at = $1, deleted_by_code = $2, scan_status = 'available',
           stock_applied_at = CASE WHEN $3 THEN NULL ELSE stock_applied_at END,
           remapped_to_session_id = CASE WHEN $3 THEN $4 ELSE remapped_to_session_id END,
           remapped_at = CASE WHEN $3 THEN $1 ELSE remapped_at END
       WHERE id = $4`,
      [new Date(), userCode, discard, id],
    );

    await client.query('COMMIT');

    const summary = { ...scanCounts, stockReversed, mode: discard ? 'discard' : 'replace' };

    await storage.logActivity({
      pageName: 'OrderImport',
      action: discard ? 'delete-discard' : 'delete-for-replace',
      entityType: 'orderImportSession',
      entityId: id,
      userCode,
      userName,
      details: { csvFileName: session.csv_file_name, plant: session.plant, ...summary },
    });

    res.json({ success: true, ...summary });

    broadcastOrderImportUpdate();
    // Tell anyone actively scanning against this session right now, before they hit a scan
    // and get a confusing 404 — see broadcastSessionDeleted's comment in order-scan.ts.
    broadcastSessionDeleted(id);

    // On a permanent (discard) delete, don't leave the plant idle: if the CSV we just removed
    // was the active/front part, promote the next 'available' part in the same group so
    // scanning continues on Part 2 automatically. Runs after COMMIT (seedAndActivateSession
    // opens its own transaction) and self-guards — a no-op if another part is already active
    // or none remain. Not done for a replace delete: there, the corrected re-upload reclaims
    // the front slot itself, so promoting a later part would just fight FIFO order.
    if (discard) {
      try {
        const nextId = await autoActivateNextInScope(
          {
            id,
            plant: session.plant,
            receivingSessionId: session.receiving_session_id ?? null,
            csvFileName: session.csv_file_name,
          },
          userCode,
        );
        if (nextId) broadcastOrderImportUpdate();
      } catch (e) {
        console.error('[order-import] auto-activate next part after discard failed:', e);
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err instanceof Error ? err.message : 'Delete failed' });
  } finally {
    client.release();
  }
});

// GET /api/order-import/master-view?date=YYYY-MM-DD&plant=X
//   or  /api/order-import/master-view?sessionIds=1,2,3
// Returns all items from all matching sessions, merged in upload order. sessionIds scopes
// the view to exactly the given sessions (e.g. one just-uploaded batch) instead of every
// session for a plant/day — used by OrderImport's batch-upload Master View.
router.get('/order-import/master-view', requireImportViewAccess, async (req: Request, res: Response) => {
  try {
    const dateStr = String(req.query.date ?? '');
    const sessionIdsParam = String(req.query.sessionIds ?? '').trim();
    // A dispatch user (importViewPlant set) is always forced to their own plant, whichever
    // mode is used below — in sessionIds mode this just adds an extra AND so any session
    // outside their plant silently drops out rather than being denied entirely.
    const forcedPlant = (req as any).importViewPlant as string | null;

    let conditions: any[];
    if (sessionIdsParam) {
      const ids = sessionIdsParam.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      if (ids.length === 0) return res.status(400).json({ message: 'sessionIds must be a comma-separated list of numbers' });
      conditions = [eq(orderImportSessions.isDeleted, false), inArray(orderImportSessions.id, ids)];
      if (forcedPlant) conditions.push(sql`LOWER(${orderImportSessions.plant}) = LOWER(${forcedPlant})`);
    } else if (dateStr) {
      conditions = [
        eq(orderImportSessions.isDeleted, false),
        sql`(${orderImportSessions.createdAt})::date = ${dateStr}::date`,
      ];
      if (forcedPlant) {
        conditions.push(sql`LOWER(${orderImportSessions.plant}) = LOWER(${forcedPlant})`);
      } else if (req.query.plant) {
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
        AND ose.voided IS NOT TRUE
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
