import { Router, Request, Response } from 'express';
import { Client as NotionClient } from '@notionhq/client';
import { db, pool } from '../db';
import {
  scanSessions,
  scanSessionItems,
  scanSessionExtras,
  scanSessionPalletScans,
  products,
  insertScanSessionSchema,
  insertScanSessionItemSchema,
  insertScanSessionExtraSchema,
  insertScanSessionPalletScanSchema,
} from '@shared/schema';
import { eq, desc, inArray, count, asc } from 'drizzle-orm';
import { z } from 'zod';
import { requirePageWrite } from '../lib/pageAccess';

const router = Router();

// ── List all sessions ──────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const { userCode } = req.query;
    const sessions = userCode
      ? await db.select().from(scanSessions).where(eq(scanSessions.createdByCode, String(userCode))).orderBy(desc(scanSessions.createdAt))
      : await db.select().from(scanSessions).orderBy(desc(scanSessions.createdAt));

    // Attach item/extra counts
    const sessionIds = sessions.map((s) => s.id);
    if (!sessionIds.length) return res.json([]);

    const items = await db
      .select()
      .from(scanSessionItems)
      .where(inArray(scanSessionItems.sessionId, sessionIds));

    const extras = await db
      .select()
      .from(scanSessionExtras)
      .where(inArray(scanSessionExtras.sessionId, sessionIds));

    const result = sessions.map((session) => {
      const sessionItems = items.filter((i) => i.sessionId === session.id);
      const sessionExtras = extras.filter((e) => e.sessionId === session.id);
      return {
        ...session,
        totalExpected: sessionItems.reduce((s, i) => s + (i.expectedQty ?? 0), 0),
        totalScanned: sessionItems.reduce((s, i) => s + (i.scannedQty ?? 0), 0),
        totalExtras: sessionExtras.reduce((s, e) => s + (e.quantity ?? 0), 0),
        itemCount: sessionItems.length,
      };
    });

    return res.json(result);
  } catch (error) {
    console.error('Error listing scan sessions:', error);
    return res.status(500).json({ error: 'Failed to list scan sessions' });
  }
});

// ── Get single session with full items + extras ────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid session ID' });

  try {
    const [session] = await db.select().from(scanSessions).where(eq(scanSessions.id, id));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const items = await db
      .select()
      .from(scanSessionItems)
      .where(eq(scanSessionItems.sessionId, id));

    const extras = await db
      .select()
      .from(scanSessionExtras)
      .where(eq(scanSessionExtras.sessionId, id))
      .orderBy(desc(scanSessionExtras.scannedAt));

    return res.json({ ...session, items, extras });
  } catch (error) {
    console.error('Error fetching scan session:', error);
    return res.status(500).json({ error: 'Failed to fetch scan session' });
  }
});

// ── Create session + bulk insert items ────────────────────────────────────
router.post('/', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
  try {
    const { session: sessionData, items: itemsData } = req.body as {
      session: z.infer<typeof insertScanSessionSchema>;
      items: Array<Omit<z.infer<typeof insertScanSessionItemSchema>, 'sessionId'>>;
    };

    const validSession = insertScanSessionSchema.parse({
      ...sessionData,
      createdByCode: (req.user as any)?.userCode ?? sessionData.createdByCode,
      createdByName: (req.user as any)?.name ?? sessionData.createdByName,
    });

    const [newSession] = await db.insert(scanSessions).values(validSession).returning();

    const insertedItems =
      itemsData?.length
        ? await db
            .insert(scanSessionItems)
            .values(itemsData.map((item) => ({ ...item, sessionId: newSession.id })))
            .returning()
        : [];

    return res.status(201).json({ ...newSession, items: insertedItems, extras: [] });
  } catch (error) {
    console.error('Error creating scan session:', error);
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors });
    return res.status(500).json({ error: 'Failed to create scan session' });
  }
});

// ── Update session status ──────────────────────────────────────────────────
router.patch('/:id', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid session ID' });

  try {
    const { status } = req.body as { status?: string };
    const [updated] = await db
      .update(scanSessions)
      .set({ status, updatedAt: new Date() })
      .where(eq(scanSessions.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Session not found' });
    return res.json(updated);
  } catch (error) {
    console.error('Error updating scan session:', error);
    return res.status(500).json({ error: 'Failed to update scan session' });
  }
});

// ── Increment scannedQty for an item ──────────────────────────────────────
// Accepts { increment: number } — uses a SQL-side add so concurrent scans
// never overwrite each other (avoids stale-closure race conditions on the client).
router.patch('/:id/items/:itemId', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
  const sessionId = parseInt(req.params.id);
  const itemId = parseInt(req.params.itemId);
  if (isNaN(sessionId) || isNaN(itemId)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const { increment, productId } = req.body as { increment: number; productId?: number | null };
    const inc = Number(increment);
    if (!Number.isFinite(inc) || inc <= 0) {
      return res.status(400).json({ error: 'increment must be a positive number' });
    }

    // Increment scannedQty and — if productId is provided and the row currently has no
    // product linked — store it so the report JOIN to products works going forward.
    await pool.query(
      `UPDATE scan_session_items
       SET scanned_qty = COALESCE(scanned_qty, 0) + $1,
           updated_at  = NOW(),
           product_id  = CASE WHEN product_id IS NULL THEN $3 ELSE product_id END
       WHERE id = $2`,
      [inc, itemId, productId ?? null],
    );

    const result = await pool.query('SELECT * FROM scan_session_items WHERE id = $1', [itemId]);
    const updated = result.rows[0];

    if (!updated) return res.status(404).json({ error: 'Item not found' });

    await db
      .update(scanSessions)
      .set({ updatedAt: new Date() })
      .where(eq(scanSessions.id, sessionId));

    return res.json(updated);
  } catch (error) {
    console.error('Error updating scan session item:', error);
    return res.status(500).json({ error: 'Failed to update item' });
  }
});

// ── Upsert an extra scan ───────────────────────────────────────────────────
router.post('/:id/extras', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
  const sessionId = parseInt(req.params.id);
  if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

  try {
    const payload = insertScanSessionExtraSchema.parse({
      ...req.body,
      sessionId,
      scannedByCode: (req.user as any)?.userCode ?? req.body.scannedByCode,
      scannedByName: (req.user as any)?.name ?? req.body.scannedByName,
    });

    // If an extra for this code already exists in the session, increment qty
    const existingForCode = (
      await db.select().from(scanSessionExtras).where(eq(scanSessionExtras.sessionId, sessionId))
    ).find((e) => e.code === payload.code);

    let result;
    if (existingForCode) {
      [result] = await db
        .update(scanSessionExtras)
        .set({ quantity: (existingForCode.quantity ?? 0) + (payload.quantity ?? 1), scannedAt: new Date() })
        .where(eq(scanSessionExtras.id, existingForCode.id))
        .returning();
    } else {
      [result] = await db.insert(scanSessionExtras).values(payload).returning();
    }

    await db.update(scanSessions).set({ updatedAt: new Date() }).where(eq(scanSessions.id, sessionId));

    return res.status(201).json(result);
  } catch (error) {
    console.error('Error adding extra scan:', error);
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors });
    return res.status(500).json({ error: 'Failed to add extra scan' });
  }
});

// ── Bulk-sync all item scannedQty values for a session ───────────────────
// Called when the user navigates away from the scan view to guarantee
// every item's quantity is persisted, even if individual PATCHes were missed.
router.put('/:id/sync-items', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
  const sessionId = parseInt(req.params.id);
  if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

  try {
    const { items } = req.body as { items: Array<{ id: number; scannedQty: number }> };
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ updated: 0 });
    }

    // Update each item using the absolute scannedQty the client reports
    await Promise.all(
      items.map(({ id, scannedQty }) =>
        pool.query(
          'UPDATE scan_session_items SET scanned_qty = $1, updated_at = NOW() WHERE id = $2 AND session_id = $3',
          [Math.max(0, scannedQty), id, sessionId],
        ),
      ),
    );

    await pool.query(
      'UPDATE scan_sessions SET updated_at = NOW() WHERE id = $1',
      [sessionId],
    );

    return res.json({ updated: items.length });
  } catch (error) {
    console.error('Error syncing session items:', error);
    return res.status(500).json({ error: 'Failed to sync session items' });
  }
});

// ── Record a pallet scan ──────────────────────────────────────────────────
// One row per confirmed scan event. palletNumber is auto-assigned as
// (total prior pallet scans for this item in this session) + 1.
router.post('/:id/pallet-scans', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
  const sessionId = parseInt(req.params.id);
  if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

  try {
    const body = req.body as {
      sessionItemId?: number;
      barcode: string;
      sku?: string;
      itemName: string;
      productId?: number;
      quantity?: number;
      numPallets?: number;   // calculated: quantity ÷ itemsPerPallet (e.g. 1.03)
      isExtra?: boolean;
      scannedByCode?: string;
      scannedByName?: string;
    };

    // Count existing pallet scans for this item (or for the barcode if extra)
    // to derive the next sequential pallet number.
    const [{ value: existing }] = await db
      .select({ value: count() })
      .from(scanSessionPalletScans)
      .where(
        body.sessionItemId
          ? eq(scanSessionPalletScans.sessionItemId, body.sessionItemId)
          : eq(scanSessionPalletScans.sessionId, sessionId),
      );

    const palletNumber = (existing ?? 0) + 1;

    const payload = insertScanSessionPalletScanSchema.parse({
      sessionId,
      sessionItemId: body.sessionItemId ?? null,
      barcode: body.barcode,
      sku: body.sku ?? null,
      itemName: body.itemName,
      productId: body.productId ?? null,
      palletNumber,
      quantity: body.quantity ?? 1,
      numPallets: body.numPallets ?? null,
      isExtra: body.isExtra ?? false,
      scannedByCode: (req.user as any)?.userCode ?? body.scannedByCode ?? null,
      scannedByName: (req.user as any)?.name ?? body.scannedByName ?? null,
    });

    const [result] = await db.insert(scanSessionPalletScans).values(payload).returning();
    return res.status(201).json(result);
  } catch (error) {
    console.error('Error recording pallet scan:', error);
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors });
    return res.status(500).json({ error: 'Failed to record pallet scan' });
  }
});

// ── Per-session stock report (specs + stock levels + pallet breakdown) ───
router.get('/:id/stock-report', async (req: Request, res: Response) => {
  const sessionId = parseInt(req.params.id);
  if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

  try {
    const [session] = await db.select().from(scanSessions).where(eq(scanSessions.id, sessionId));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Session items joined with product specs + current stock
    const items = await db
      .select({
        id: scanSessionItems.id,
        sku: scanSessionItems.sku,
        barcode: scanSessionItems.barcode,
        itemName: scanSessionItems.itemName,
        itemNo: scanSessionItems.itemNo,
        sapCode: scanSessionItems.sapCode,
        productId: scanSessionItems.productId,
        expectedQty: scanSessionItems.expectedQty,
        scannedQty: scanSessionItems.scannedQty,
        inStock: products.inStock,
        hsnCode: products.hsnCode,
        category: products.category,
        itemsPerPallet: products.itemsPerPallet,
        volumeInCuFt: products.volumeInCuFt,
        productSapCode: products.sapCode,
        productItemNo: products.itemNo,
      })
      .from(scanSessionItems)
      .leftJoin(products, eq(scanSessionItems.productId, products.id))
      .where(eq(scanSessionItems.sessionId, sessionId))
      .orderBy(asc(scanSessionItems.itemName));

    // Pallet scans for this session (order items only — extras handled separately)
    const palletScans = await db
      .select()
      .from(scanSessionPalletScans)
      .where(eq(scanSessionPalletScans.sessionId, sessionId))
      .orderBy(asc(scanSessionPalletScans.palletNumber));

    const itemsWithPallets = items.map((item) => {
      const pallets = palletScans
        .filter((p) => p.sessionItemId === item.id)
        .map((p) => ({
          id: p.id,
          palletNumber: p.palletNumber,
          quantity: p.quantity,
          scannedByName: p.scannedByName,
          scannedAt: p.scannedAt,
          isExtra: p.isExtra,
        }));
      return {
        sessionItemId: item.id,
        sku: item.sku,
        barcode: item.barcode ?? null,
        itemName: item.itemName,
        itemNo: item.itemNo ?? item.productItemNo ?? null,
        sapCode: item.sapCode ?? item.productSapCode ?? null,
        productId: item.productId ?? null,
        expectedQty: item.expectedQty ?? 0,
        scannedQty: item.scannedQty ?? 0,
        inStock: item.inStock ?? null,
        hsnCode: item.hsnCode ?? null,
        category: item.category ?? null,
        itemsPerPallet: item.itemsPerPallet ?? null,
        volumeInCuFt: item.volumeInCuFt ?? null,
        pallets,
      };
    });

    // Extras joined with product specs
    const extras = await db
      .select({
        id: scanSessionExtras.id,
        code: scanSessionExtras.code,
        itemName: scanSessionExtras.itemName,
        sku: scanSessionExtras.sku,
        productId: scanSessionExtras.productId,
        quantity: scanSessionExtras.quantity,
        reason: scanSessionExtras.reason,
        scannedByName: scanSessionExtras.scannedByName,
        scannedAt: scanSessionExtras.scannedAt,
        inStock: products.inStock,
        hsnCode: products.hsnCode,
        category: products.category,
        itemsPerPallet: products.itemsPerPallet,
      })
      .from(scanSessionExtras)
      .leftJoin(products, eq(scanSessionExtras.productId, products.id))
      .where(eq(scanSessionExtras.sessionId, sessionId))
      .orderBy(desc(scanSessionExtras.scannedAt));

    return res.json({ session, items: itemsWithPallets, extras });
  } catch (error) {
    console.error('Error generating session stock report:', error);
    return res.status(500).json({ error: 'Failed to generate stock report' });
  }
});

// ── Get all pallet scans for a session ────────────────────────────────────
router.get('/:id/pallet-scans', async (req: Request, res: Response) => {
  const sessionId = parseInt(req.params.id);
  if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

  try {
    const rows = await db
      .select()
      .from(scanSessionPalletScans)
      .where(eq(scanSessionPalletScans.sessionId, sessionId))
      .orderBy(scanSessionPalletScans.scannedAt);
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching pallet scans:', error);
    return res.status(500).json({ error: 'Failed to fetch pallet scans' });
  }
});

// ─── Reports ───────────────────────────────────────────────────────────────

// Pallet stock sheet: one row per unique item, with individual pallet scan events
router.get('/reports/pallet-stock-sheet', async (_req: Request, res: Response) => {
  try {
    // Fetch all pallet scans joined with product data for category
    const rows = await db
      .select({
        id: scanSessionPalletScans.id,
        sessionId: scanSessionPalletScans.sessionId,
        sessionItemId: scanSessionPalletScans.sessionItemId,
        barcode: scanSessionPalletScans.barcode,
        sku: scanSessionPalletScans.sku,
        itemName: scanSessionPalletScans.itemName,
        productId: scanSessionPalletScans.productId,
        palletNumber: scanSessionPalletScans.palletNumber,
        quantity: scanSessionPalletScans.quantity,
        isExtra: scanSessionPalletScans.isExtra,
        scannedByName: scanSessionPalletScans.scannedByName,
        scannedAt: scanSessionPalletScans.scannedAt,
        category: products.category,
        productName: products.name,
        itemsPerPallet: products.itemsPerPallet,
        orderName: scanSessions.orderName,
      })
      .from(scanSessionPalletScans)
      .leftJoin(products, eq(scanSessionPalletScans.productId, products.id))
      .leftJoin(scanSessions, eq(scanSessionPalletScans.sessionId, scanSessions.id))
      .orderBy(asc(scanSessionPalletScans.itemName), asc(scanSessionPalletScans.scannedAt));

    // Group by barcode so the frontend gets one entry per item with all pallets listed
    const itemMap = new Map<string, {
      barcode: string;
      sku: string | null;
      itemName: string;
      productId: number | null;
      category: string | null;
      itemsPerPallet: number | null;
      totalQuantity: number;
      palletCount: number;
      pallets: Array<{
        id: number;
        sessionId: number;
        orderName: string | null;
        palletNumber: number;
        quantity: number;
        isExtra: boolean | null;
        scannedByName: string | null;
        scannedAt: Date | null;
      }>;
    }>();

    for (const row of rows) {
      const key = row.barcode;
      if (!itemMap.has(key)) {
        itemMap.set(key, {
          barcode: row.barcode,
          sku: row.sku,
          itemName: row.productName ?? row.itemName,
          productId: row.productId,
          category: row.category ?? null,
          itemsPerPallet: row.itemsPerPallet ?? null,
          totalQuantity: 0,
          palletCount: 0,
          pallets: [],
        });
      }
      const entry = itemMap.get(key)!;
      entry.totalQuantity += row.quantity ?? 0;
      entry.palletCount += 1;
      entry.pallets.push({
        id: row.id,
        sessionId: row.sessionId,
        orderName: row.orderName ?? null,
        palletNumber: row.palletNumber,
        quantity: row.quantity ?? 0,
        isExtra: row.isExtra,
        scannedByName: row.scannedByName,
        scannedAt: row.scannedAt,
      });
    }

    return res.json(Array.from(itemMap.values()));
  } catch (error) {
    console.error('Error generating pallet stock sheet:', error);
    return res.status(500).json({ error: 'Failed to generate pallet stock sheet' });
  }
});

// Stock sheet: all sessions with item-level detail
router.get('/reports/stock-sheet', async (_req: Request, res: Response) => {
  try {
    const sessions = await db.select().from(scanSessions).orderBy(desc(scanSessions.createdAt));
    const sessionIds = sessions.map((s) => s.id);
    if (!sessionIds.length) return res.json([]);

    const items = await db
      .select()
      .from(scanSessionItems)
      .where(inArray(scanSessionItems.sessionId, sessionIds));

    const extras = await db
      .select()
      .from(scanSessionExtras)
      .where(inArray(scanSessionExtras.sessionId, sessionIds));

    const report = sessions.map((session) => ({
      ...session,
      items: items.filter((i) => i.sessionId === session.id),
      extras: extras.filter((e) => e.sessionId === session.id),
    }));

    return res.json(report);
  } catch (error) {
    console.error('Error generating stock sheet:', error);
    return res.status(500).json({ error: 'Failed to generate stock sheet' });
  }
});

// Extra orders report: all extras across all sessions (old scan_session_extras + new order_scan_events)
// ?grouped=true  → one row per barcode, SUM quantities across all CSVs (default for UI)
// ?grouped=false → one row per scan event (detailed / backwards-compat mode)
// ?date=YYYY-MM-DD → filter scan events to that date before grouping/listing
router.get('/reports/extras', async (_req: Request, res: Response) => {
  try {
    const req = _req;
    const limit  = Math.max(1, Math.min(200, parseInt(String(req.query.limit  ?? '50'), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'),  10) || 0);
    const grouped = req.query.grouped !== 'false'; // default true
    const dateParam = typeof req.query.date === 'string' && req.query.date.trim()
      ? req.query.date.trim()
      : null;

    if (grouped) {
      // ── Grouped mode: one row per barcode, quantities summed across all CSVs ──
      // Date filter applies to individual scan events before grouping, so filtering
      // to "yesterday" shows only the boxes that arrived on that specific day.
      const dateParams: any[] = [];
      let pIdx = 1;
      const oldDateWhere = dateParam ? `WHERE DATE(se.scanned_at AT TIME ZONE 'Asia/Kolkata') = $${pIdx}` : '';
      const newDateAnd   = dateParam ? `AND   DATE(ose.scanned_at AT TIME ZONE 'Asia/Kolkata') = $${pIdx}` : '';
      if (dateParam) { dateParams.push(dateParam); pIdx++; }

      const limitIdx  = pIdx++;
      const offsetIdx = pIdx++;
      dateParams.push(limit, offset);

      const sql = `
        WITH old_e AS (
          SELECT
            LOWER(COALESCE(se.code, ''))                                    AS norm_bc,
            COALESCE(se.code, '')                                           AS barcode,
            COALESCE(p.name, p_bc.name, se.item_name, se.code)             AS item_name,
            COALESCE(se.quantity, 0)                                        AS qty,
            se.scanned_at,
            COALESCE(NULLIF(p.items_per_pallet, 0), NULLIF(p_bc.items_per_pallet, 0), 0) AS ipp,
            COALESCE(p.sap_code,  p_bc.sap_code)                           AS sap_code,
            COALESCE(p.hsn_code,  p_bc.hsn_code)                           AS hsn_code,
            COALESCE(p.category,  p_bc.category)                           AS category,
            COALESCE(p.brand,     p_bc.brand)                              AS brand
          FROM scan_session_extras se
          LEFT JOIN products p    ON p.id    = se.product_id
          LEFT JOIN products p_bc ON p.id IS NULL
                                  AND p_bc.barcode IS NOT NULL
                                  AND LOWER(p_bc.barcode) = LOWER(se.code)
          ${oldDateWhere}
        ),
        new_e AS (
          SELECT
            LOWER(COALESCE(ose.barcode, ''))                        AS norm_bc,
            COALESCE(ose.barcode, '')                               AS barcode,
            COALESCE(p.name, ose.item_name, ose.barcode)            AS item_name,
            COALESCE(ose.total_qty, 0)                              AS qty,
            ose.scanned_at,
            COALESCE(ose.items_per_pallet, p.items_per_pallet, 0)   AS ipp,
            CASE
              WHEN UPPER(ois.plant) LIKE '%VAL%' THEN COALESCE(p.gj_sap, p.sap_code)
              WHEN UPPER(ois.plant) LIKE '%IND%' THEN COALESCE(p.mp_sap, p.sap_code)
              ELSE p.sap_code
            END                                                     AS sap_code,
            p.hsn_code                                              AS hsn_code,
            p.category                                              AS category,
            p.brand                                                 AS brand
          FROM order_scan_events ose
          JOIN  order_import_sessions ois ON ois.id = ose.session_id
          LEFT JOIN products p ON LOWER(p.barcode) = LOWER(ose.barcode)
          WHERE ose.is_extra = true
          ${newDateAnd}
        ),
        combined AS (
          SELECT * FROM old_e
          UNION ALL
          SELECT * FROM new_e
        ),
        grouped AS (
          SELECT
            norm_bc,
            MAX(barcode)                                            AS barcode,
            MAX(item_name)                                          AS "itemName",
            SUM(qty)                                                AS "totalQuantity",
            MAX(ipp)                                                AS "itemsPerPallet",
            CASE WHEN MAX(ipp) > 0
              THEN ROUND(SUM(qty)::numeric / MAX(ipp), 2)
              ELSE NULL
            END                                                     AS "totalPallets",
            MIN(scanned_at)                                         AS "firstArrived",
            MAX(scanned_at)                                         AS "lastArrived",
            MAX(sap_code)                                           AS "sapCode",
            MAX(hsn_code)                                           AS "hsnCode",
            MAX(category)                                           AS "category",
            MAX(brand)                                              AS "brand"
          FROM combined
          GROUP BY norm_bc
          ORDER BY SUM(qty) DESC, MAX(item_name)
        )
        SELECT
          g.*,
          COUNT(*) OVER()                                           AS _total_count,
          SUM(g."totalQuantity") OVER()                             AS _total_qty
        FROM grouped g
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `;

      const result = await pool.query(sql, dateParams);
      const rows = result.rows;
      const total         = rows.length > 0 ? Number(rows[0]._total_count) : 0;
      const totalQuantity = rows.length > 0 ? Number(rows[0]._total_qty)   : 0;
      const items = rows.map(({ _total_count, _total_qty, ...r }) => r);

      return res.json({ items, total, totalQuantity, limit, offset, grouped: true });
    }

    // ── Detailed mode (grouped=false): one row per scan event ────────────────
    const dateParams: string[] = dateParam ? [dateParam] : [];
    const oldWhere   = dateParam ? `WHERE DATE(se.scanned_at) = $1` : '';
    const osDateAnd  = dateParam ? `AND DATE(ose.scanned_at) = $1` : '';

    const oldRows = await pool.query(
      `SELECT
         se.id,
         se.session_id        AS "sessionId",
         ss.order_name        AS "orderName",
         ss.csv_name          AS "csvName",
         se.code,
         se.item_name         AS "itemName",
         se.sku,
         se.quantity,
         se.reason,
         se.scanned_by_name   AS "scannedByName",
         se.scanned_at        AS "scannedAt",
         CASE
           WHEN COALESCE(p.items_per_pallet, 0) > 0
           THEN ROUND(CAST(se.quantity AS NUMERIC) / p.items_per_pallet, 2)
           ELSE NULL
         END                  AS pallets
       FROM scan_session_extras se
       INNER JOIN scan_sessions ss ON se.session_id = ss.id
       LEFT  JOIN products p ON p.id = se.product_id
                             OR (se.product_id IS NULL AND LOWER(p.barcode) = LOWER(se.code))
       ${oldWhere}
       ORDER BY se.scanned_at DESC`,
      dateParams,
    );

    const osRows = await pool.query(
      `SELECT
         ose.id,
         ose.session_id                       AS "sessionId",
         ois.csv_file_name                    AS "orderName",
         ois.csv_file_name                    AS "csvName",
         ose.barcode                          AS code,
         COALESCE(ose.item_name, p.name, ose.barcode) AS "itemName",
         NULL::text                           AS sku,
         ose.total_qty                        AS quantity,
         'not_in_order'                       AS reason,
         ose.scanned_by_name                  AS "scannedByName",
         ose.scanned_at                       AS "scannedAt",
         CASE
           WHEN COALESCE(ose.pallets, 0) > 0
             THEN ROUND(CAST(ose.pallets AS NUMERIC), 2)
           WHEN COALESCE(ose.items_per_pallet, 0) > 0
             THEN ROUND(CAST(ose.total_qty AS NUMERIC) / ose.items_per_pallet, 2)
           WHEN COALESCE(p.items_per_pallet, 0) > 0
             THEN ROUND(CAST(ose.total_qty AS NUMERIC) / p.items_per_pallet, 2)
           ELSE NULL
         END                                  AS pallets
       FROM order_scan_events ose
       INNER JOIN order_import_sessions ois ON ois.id = ose.session_id
       LEFT  JOIN products p ON LOWER(p.barcode) = LOWER(ose.barcode)
       WHERE ose.is_extra = true
         ${osDateAnd}
       ORDER BY ose.scanned_at DESC`,
      dateParams,
    );

    const merged = [...oldRows.rows, ...osRows.rows].sort((a, b) => {
      const ta = a.scannedAt ? new Date(a.scannedAt).getTime() : 0;
      const tb = b.scannedAt ? new Date(b.scannedAt).getTime() : 0;
      return tb - ta;
    });

    const total = merged.length;
    const totalQuantity = merged.reduce((s, e) => s + (Number(e.quantity) || 0), 0);
    const items = merged.slice(offset, offset + limit);

    return res.json({ items, total, totalQuantity, limit, offset, grouped: false });
  } catch (error) {
    console.error('Error generating extras report:', error);
    return res.status(500).json({ error: 'Failed to generate extras report' });
  }
});

// ── Overall stock report: all orders aggregated by SKU ────────────────────
// Groups every scan_session_item by barcode/SKU, sums expected + scanned across
// all sessions, and enriches each row with live product specs from the inventory.
router.get('/reports/overall-stock', async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        sku: scanSessionItems.sku,
        barcode: scanSessionItems.barcode,
        itemName: scanSessionItems.itemName,
        itemNo: scanSessionItems.itemNo,
        sapCode: scanSessionItems.sapCode,
        productId: scanSessionItems.productId,
        expectedQty: scanSessionItems.expectedQty,
        scannedQty: scanSessionItems.scannedQty,
        sessionId: scanSessionItems.sessionId,
        sessionOrderName: scanSessions.orderName,
        sessionStatus: scanSessions.status,
        sessionCreatedAt: scanSessions.createdAt,
        // Live product specs & stock
        inStock: products.inStock,
        hsnCode: products.hsnCode,
        category: products.category,
        itemsPerPallet: products.itemsPerPallet,
        volumeInCuFt: products.volumeInCuFt,
        productSapCode: products.sapCode,
        productItemNo: products.itemNo,
        productName: products.name,
      })
      .from(scanSessionItems)
      .innerJoin(scanSessions, eq(scanSessionItems.sessionId, scanSessions.id))
      .leftJoin(products, eq(scanSessionItems.productId, products.id))
      .orderBy(asc(scanSessionItems.itemName));

    // Aggregate by barcode (fall back to sku when barcode is null)
    const skuMap = new Map<string, {
      sku: string;
      barcode: string | null;
      itemName: string;
      itemNo: string | null;
      sapCode: string | null;
      productId: number | null;
      inStock: number | null;
      hsnCode: string | null;
      category: string | null;
      itemsPerPallet: number | null;
      volumeInCuFt: string | null;
      totalExpected: number;
      totalScanned: number;
      sessions: Array<{
        sessionId: number;
        orderName: string;
        status: string;
        expectedQty: number;
        scannedQty: number;
      }>;
    }>();

    for (const row of rows) {
      const key = row.barcode ?? row.sku;
      if (!skuMap.has(key)) {
        skuMap.set(key, {
          sku: row.sku,
          barcode: row.barcode ?? null,
          itemName: row.productName ?? row.itemName,
          itemNo: row.itemNo ?? row.productItemNo ?? null,
          sapCode: row.sapCode ?? row.productSapCode ?? null,
          productId: row.productId ?? null,
          inStock: row.inStock ?? null,
          hsnCode: row.hsnCode ?? null,
          category: row.category ?? null,
          itemsPerPallet: row.itemsPerPallet ?? null,
          volumeInCuFt: row.volumeInCuFt ?? null,
          totalExpected: 0,
          totalScanned: 0,
          sessions: [],
        });
      }
      const entry = skuMap.get(key)!;
      entry.totalExpected += row.expectedQty ?? 0;
      entry.totalScanned += row.scannedQty ?? 0;
      entry.sessions.push({
        sessionId: row.sessionId,
        orderName: row.sessionOrderName,
        status: row.sessionStatus ?? 'scanning',
        expectedQty: row.expectedQty ?? 0,
        scannedQty: row.scannedQty ?? 0,
      });
    }

    return res.json(Array.from(skuMap.values()));
  } catch (error) {
    console.error('Error generating overall stock report:', error);
    return res.status(500).json({ error: 'Failed to generate overall stock report' });
  }
});

// ── Completed-sessions stock sheet ───────────────────────────────────────
// Returns every scanned item (scannedQty > 0) from ALL sessions,
// grouped by barcode/SKU with full product specs and which orders it appeared in.
// Includes active (scanning) sessions so the report updates live as boxes are scanned.
router.get('/reports/completed-stock', async (req: Request, res: Response) => {
  try {
    // Optional date filter: ?date=YYYY-MM-DD — filters by the session's arrival date
    const dateParam = typeof req.query.date === 'string' && req.query.date.trim()
      ? req.query.date.trim()
      : null;

    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '10'), 10) || 10));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    // CTE pre-aggregates pallet scan data once — avoids N correlated subqueries per row.
    // The WHERE sci.scanned_qty > 0 filter at SQL level keeps the result set small.
    const queryParams: string[] = [];
    const dateFilter = dateParam
      ? `AND DATE(ss.created_at) = $${queryParams.push(dateParam)}`
      : '';

    const rawRows = await pool.query(`
      WITH item_pallets AS (
        SELECT
          session_item_id,
          MAX(product_id) FILTER (WHERE product_id IS NOT NULL)    AS pallet_product_id,
          ROUND(CAST(SUM(num_pallets) AS NUMERIC), 2)              AS total_pallets
        FROM  scan_session_pallet_scans
        WHERE session_item_id IS NOT NULL
        GROUP BY session_item_id
      )
      SELECT
        sci.sku,
        sci.barcode,
        sci.item_name                                             AS "itemName",
        sci.item_no                                               AS "itemNo",
        sci.sap_code                                              AS "sapCode",
        sci.scanned_qty                                           AS "scannedQty",
        sci.session_id                                            AS "sessionId",
        ss.order_name                                             AS "sessionOrderName",
        ss.status                                                 AS "sessionStatus",
        ss.created_at                                             AS "sessionCreatedAt",
        COALESCE(sci.product_id, ip.pallet_product_id)           AS "productId",
        COALESCE(p.in_stock,         p_bc.in_stock)              AS "inStock",
        COALESCE(p.hsn_code,         p_bc.hsn_code)              AS "hsnCode",
        COALESCE(p.category,         p_bc.category)              AS category,
        COALESCE(
          NULLIF(p.items_per_pallet, 0), NULLIF(p.pallets, 0),
          NULLIF(p_bc.items_per_pallet, 0), NULLIF(p_bc.pallets, 0)
        )                                                         AS "itemsPerPallet",
        COALESCE(p.volume_in_cu_ft,  p_bc.volume_in_cu_ft)      AS "volumeInCuFt",
        COALESCE(p.sap_code,         p_bc.sap_code)              AS "productSapCode",
        COALESCE(p.item_no,          p_bc.item_no)               AS "productItemNo",
        COALESCE(p.name,             p_bc.name)                  AS "productName",
        COALESCE(p.brand,            p_bc.brand)                 AS brand,
        CASE
          WHEN UPPER(ss.plant) LIKE '%VAL%'
            THEN COALESCE(p.gj_sap, p_bc.gj_sap, p.sap_code, p_bc.sap_code, sci.sap_code)
          WHEN UPPER(ss.plant) LIKE '%IND%'
            THEN COALESCE(p.mp_sap, p_bc.mp_sap, p.sap_code, p_bc.sap_code, sci.sap_code)
          ELSE COALESCE(p.sap_code,  p_bc.sap_code, sci.sap_code)
        END                                                       AS "plantSapCode",
        ip.total_pallets                                          AS "storedNumPallets"
      FROM  scan_session_items sci
      JOIN  scan_sessions ss  ON ss.id  = sci.session_id
      LEFT  JOIN item_pallets ip ON ip.session_item_id = sci.id
      LEFT  JOIN products p    ON p.id    = COALESCE(sci.product_id, ip.pallet_product_id)
      LEFT  JOIN products p_bc ON p.id IS NULL
                               AND p_bc.barcode IS NOT NULL
                               AND LOWER(p_bc.barcode) = LOWER(COALESCE(sci.barcode, sci.sku))
      WHERE sci.scanned_qty > 0
        ${dateFilter}
      ORDER BY sci.item_name ASC
    `, queryParams);
    type StockRow = {
      sku: string; barcode: string | null; itemName: string; itemNo: string | null;
      sapCode: string | null; scannedQty: number; sessionId: number;
      sessionOrderName: string; sessionStatus: string | null; sessionCreatedAt: Date | null;
      productId: number | null; inStock: number | null; hsnCode: string | null;
      category: string | null; itemsPerPallet: number | null; volumeInCuFt: string | null;
      productSapCode: string | null; productItemNo: string | null; productName: string | null;
      brand: string | null; storedNumPallets: number | null;
    };
    const rows: StockRow[] = rawRows.rows;

    // Also include scans from the new order-scan system.
    // When a date filter is active, sum individual scan events for that date so the
    // quantity shown reflects what actually arrived on that day (not the all-time total).
    // When no date filter, use the pre-aggregated order_scan_items totals.
    let osRawRows: { rows: StockRow[] };
    if (dateParam) {
      // order_scan_events has: barcode, item_name, pallets, total_qty, items_per_pallet,
      // is_extra, scanned_at, session_id — no sap_code column on that table.
      osRawRows = await pool.query(`
        SELECT
          COALESCE(ose.barcode, '')                                                AS sku,
          ose.barcode,
          COALESCE(MAX(p.name), MAX(ose.item_name), ose.barcode)                  AS "itemName",
          NULL::text                                                               AS "itemNo",
          MAX(CASE
            WHEN UPPER(ois.plant) LIKE '%VAL%' THEN COALESCE(p.gj_sap, p.sap_code)
            WHEN UPPER(ois.plant) LIKE '%IND%' THEN COALESCE(p.mp_sap, p.sap_code)
            ELSE p.sap_code
          END)                                                                     AS "sapCode",
          SUM(ose.total_qty)                                                       AS "scannedQty",
          ose.session_id                                                           AS "sessionId",
          MAX(ois.csv_file_name)                                                   AS "sessionOrderName",
          MAX(ois.scan_status)                                                     AS "sessionStatus",
          MAX(ose.scanned_at)                                                      AS "sessionCreatedAt",
          MAX(p.id)                                                                AS "productId",
          MAX(p.in_stock)                                                          AS "inStock",
          MAX(p.hsn_code)                                                          AS "hsnCode",
          MAX(p.category)                                                          AS category,
          MAX(COALESCE(
            NULLIF(ose.items_per_pallet, 0),
            NULLIF(p.items_per_pallet, 0),
            NULLIF(p.pallets, 0)
          ))                                                                       AS "itemsPerPallet",
          MAX(p.volume_in_cu_ft)                                                   AS "volumeInCuFt",
          MAX(p.sap_code)                                                          AS "productSapCode",
          MAX(p.item_no)                                                           AS "productItemNo",
          MAX(p.name)                                                              AS "productName",
          MAX(p.brand)                                                             AS brand,
          CASE
            WHEN MAX(COALESCE(NULLIF(ose.items_per_pallet, 0), NULLIF(p.items_per_pallet, 0), NULLIF(p.pallets, 0))) > 0
              THEN ROUND(
                SUM(ose.total_qty)::NUMERIC /
                MAX(COALESCE(NULLIF(ose.items_per_pallet, 0), NULLIF(p.items_per_pallet, 0), NULLIF(p.pallets, 0))),
                2
              )
            ELSE NULL
          END                                                                      AS "storedNumPallets"
        FROM  order_scan_events ose
        JOIN  order_import_sessions ois ON ois.id = ose.session_id
        LEFT  JOIN products p ON LOWER(p.barcode) = LOWER(ose.barcode)
        WHERE DATE(ose.scanned_at AT TIME ZONE 'Asia/Kolkata') = $1
        GROUP BY ose.barcode, ose.session_id
        ORDER BY MAX(COALESCE(p.name, ose.item_name)) ASC
      `, queryParams);
    } else {
      osRawRows = await pool.query(`
        SELECT
          COALESCE(osi.barcode, '')                                                AS sku,
          osi.barcode,
          COALESCE(p.name, osi.item_name)                                         AS "itemName",
          NULL::text                                                               AS "itemNo",
          CASE
            WHEN UPPER(ois.plant) LIKE '%VAL%' THEN COALESCE(p.gj_sap, p.sap_code, osi.sap_code)
            WHEN UPPER(ois.plant) LIKE '%IND%' THEN COALESCE(p.mp_sap, p.sap_code, osi.sap_code)
            ELSE COALESCE(p.sap_code, osi.sap_code)
          END                                                                     AS "sapCode",
          osi.total_scanned_qty                                                   AS "scannedQty",
          ois.id                                                                  AS "sessionId",
          ois.csv_file_name                                                       AS "sessionOrderName",
          ois.scan_status                                                         AS "sessionStatus",
          COALESCE(osi.last_scanned_at, ois.created_at)                           AS "sessionCreatedAt",
          p.id                                                                    AS "productId",
          p.in_stock                                                              AS "inStock",
          p.hsn_code                                                              AS "hsnCode",
          p.category,
          COALESCE(
            NULLIF(osi.items_per_pallet, 0),
            NULLIF(p.items_per_pallet, 0),
            NULLIF(p.pallets, 0)
          )                                                                       AS "itemsPerPallet",
          p.volume_in_cu_ft                                                       AS "volumeInCuFt",
          p.sap_code                                                              AS "productSapCode",
          p.item_no                                                               AS "productItemNo",
          p.name                                                                  AS "productName",
          p.brand                                                                 AS brand,
          CASE
            WHEN COALESCE(osi.items_per_pallet, 0) > 0
              THEN ROUND(CAST(osi.total_scanned_qty AS NUMERIC) / osi.items_per_pallet, 2)
            WHEN COALESCE(p.items_per_pallet, 0) > 0
              THEN ROUND(CAST(osi.total_scanned_qty AS NUMERIC) / p.items_per_pallet, 2)
            WHEN COALESCE(p.pallets, 0) > 0
              THEN ROUND(CAST(osi.total_scanned_qty AS NUMERIC) / p.pallets, 2)
            ELSE NULL
          END                                                                     AS "storedNumPallets"
        FROM  order_scan_items osi
        JOIN  order_import_sessions ois ON ois.id = osi.session_id
        LEFT  JOIN products p ON LOWER(p.barcode) = LOWER(osi.barcode)
                              OR (osi.sap_code IS NOT NULL AND LOWER(p.sap_code) = LOWER(osi.sap_code))
        WHERE osi.total_scanned_qty > 0
        ORDER BY osi.item_name ASC
      `, []);
    }
    const allRows: StockRow[] = [...rows, ...osRawRows.rows];

    // Group by barcode (fall back to sku), sum scannedQty and storedNumPallets across all sessions
    const skuMap = new Map<string, {
      srNo: number;
      sku: string;
      barcode: string | null;
      itemName: string;
      itemNo: string | null;
      sapCode: string | null;
      hsnCode: string | null;
      category: string | null;
      brand: string | null;
      itemsPerPallet: number | null;
      volumeInCuFt: string | null;
      inStock: number | null;
      totalScanned: number;
      totalPallets: number | null; // sum of stored numPallets
      orders: Array<{ name: string; status: string }>;
      lastArrived: string | null;
    }>();

    let srNo = 1;
    for (const row of allRows) {
      const key = row.barcode ?? row.sku;
      if (!skuMap.has(key)) {
        skuMap.set(key, {
          srNo: srNo++,
          sku:            row.sku,
          barcode:        row.barcode ?? null,
          itemName:       row.productName ?? row.itemName,
          itemNo:         row.itemNo ?? row.productItemNo ?? null,
          sapCode:        (row as any).plantSapCode ?? row.sapCode ?? row.productSapCode ?? null,
          hsnCode:        row.hsnCode ?? null,
          category:       row.category ?? null,
          brand:          row.brand ?? null,
          itemsPerPallet: row.itemsPerPallet != null ? Number(row.itemsPerPallet) : null,
          volumeInCuFt:   row.volumeInCuFt ?? null,
          inStock:        row.inStock != null ? Number(row.inStock) : null,
          totalScanned:   0,
          totalPallets:   null,
          orders:         [],
          lastArrived:    null,
        });
      }
      const entry = skuMap.get(key)!;
      entry.totalScanned += Number(row.scannedQty ?? 0);
      // storedNumPallets comes back as a string from PostgreSQL NUMERIC type — parse it
      const storedNum = row.storedNumPallets != null ? parseFloat(String(row.storedNumPallets)) : null;
      if (storedNum != null && !isNaN(storedNum)) {
        entry.totalPallets = parseFloat(((entry.totalPallets ?? 0) + storedNum).toFixed(2));
      }
      if (row.sessionOrderName && !entry.orders.find((o) => o.name === row.sessionOrderName)) {
        entry.orders.push({ name: row.sessionOrderName, status: row.sessionStatus ?? 'scanning' });
      }
      if (row.sessionCreatedAt) {
        const rowDate = row.sessionCreatedAt instanceof Date ? row.sessionCreatedAt : new Date(row.sessionCreatedAt);
        if (!entry.lastArrived || rowDate > new Date(entry.lastArrived)) {
          entry.lastArrived = rowDate.toISOString();
        }
      }
    }

    const items = Array.from(skuMap.values());
    const total = items.length;
    const pagedItems = items.slice(offset, offset + limit);

    return res.json({
      items: pagedItems,
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error generating completed stock sheet:', error);
    return res.status(500).json({ error: 'Failed to generate completed stock sheet' });
  }
});

// ── Scan History: every individual scan event with scanner, time, item, qty ──
// Supports filters: date, scanner name, type (regular/extra), free-text search.
// Return configured Notion DB ID (masked for display)
router.get('/reports/notion-config', (_req: Request, res: Response) => {
  const raw = process.env.SCAN_HISTORY_NOTION_DB_ID ?? '';
  return res.json({ dbId: raw || null });
});

router.get('/reports/scan-history', async (_req: Request, res: Response) => {
  try {
    const req = _req;
    const limit  = Math.max(1, Math.min(100, parseInt(String(req.query.limit  ?? '20'), 10) || 20));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const dateParam    = typeof req.query.date    === 'string' && req.query.date.trim()    ? req.query.date.trim()    : null;
    const scannerParam = typeof req.query.scanner === 'string' && req.query.scanner.trim() ? req.query.scanner.trim() : null;
    const typeParam    = typeof req.query.type    === 'string' && ['regular','extra'].includes(req.query.type) ? req.query.type : null;
    const searchParam  = typeof req.query.search  === 'string' && req.query.search.trim()  ? req.query.search.trim()  : null;

    const conditions: string[] = [];
    const params: (string | boolean)[] = [];

    if (dateParam)    { params.push(dateParam);    conditions.push(`DATE(ose.scanned_at) = $${params.length}`); }
    if (scannerParam) { params.push(scannerParam); conditions.push(`ose.scanned_by_name = $${params.length}`); }
    if (typeParam === 'regular') conditions.push(`ose.is_extra = false`);
    if (typeParam === 'extra')   conditions.push(`ose.is_extra = true`);
    if (searchParam) {
      params.push(`%${searchParam.toLowerCase()}%`);
      const n = params.length;
      conditions.push(`(LOWER(COALESCE(ose.item_name,'')) LIKE $${n} OR LOWER(COALESCE(ose.barcode,'')) LIKE $${n} OR LOWER(COALESCE(ose.scanned_by_name,'')) LIKE $${n})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const baseFrom = `FROM order_scan_events ose JOIN order_import_sessions ois ON ois.id = ose.session_id ${where}`;

    const [dataRes, countRes, summaryRes, scannersRes] = await Promise.all([
      pool.query(
        `SELECT
           ose.id,
           ose.barcode,
           ose.item_name        AS "itemName",
           ose.pallets,
           ose.total_qty        AS "totalQty",
           ose.items_per_pallet AS "itemsPerPallet",
           ose.loose_qty        AS "looseQty",
           ose.is_extra         AS "isExtra",
           ose.stv,
           ose.scanned_by_code  AS "scannedByCode",
           ose.scanned_by_name  AS "scannedByName",
           ose.scanned_at       AS "scannedAt",
           ois.csv_file_name    AS "orderName",
           ois.plant
         ${baseFrom}
         ORDER BY ose.scanned_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      pool.query(`SELECT COUNT(*) AS total ${baseFrom}`, params),
      pool.query(
        `SELECT
           COALESCE(SUM(ose.total_qty), 0)                          AS "totalBoxes",
           COALESCE(SUM(ose.pallets), 0)                            AS "totalPallets",
           COUNT(*) FILTER (WHERE ose.is_extra = true)              AS "extraCount"
         ${baseFrom}`,
        params,
      ),
      pool.query(
        `SELECT DISTINCT ose.scanned_by_name AS name
         FROM order_scan_events ose
         WHERE ose.scanned_by_name IS NOT NULL
         ORDER BY ose.scanned_by_name`,
      ),
    ]);

    return res.json({
      items:        dataRes.rows,
      total:        parseInt(countRes.rows[0].total, 10),
      totalBoxes:   parseInt(summaryRes.rows[0].totalBoxes, 10),
      totalPallets: parseFloat(summaryRes.rows[0].totalPallets),
      extraCount:   parseInt(summaryRes.rows[0].extraCount, 10),
      scanners:     scannersRes.rows.map((r: any) => r.name as string),
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error generating scan history:', error);
    return res.status(500).json({ error: 'Failed to generate scan history' });
  }
});

// ── Upload scan-history rows into an existing Notion database ────────────────
router.post('/reports/upload-to-notion', requirePageWrite('scan-history'), async (_req: Request, res: Response) => {
  try {
    const { pageId, columns, date, search, scanner, type } = _req.body as {
      pageId: string;
      columns: string[];
      date?: string;
      search?: string;
      scanner?: string;
      type?: string;
    };

    // Use env var as default; allow override from request body
    const resolvedPageId = (pageId && pageId.trim()) || process.env.SCAN_HISTORY_NOTION_DB_ID || '';

    if (!resolvedPageId || !columns || columns.length === 0) {
      return res.status(400).json({ error: 'No Notion database ID configured. Set SCAN_HISTORY_NOTION_DB_ID in .env or enter it in the dialog.' });
    }

    const notion = new NotionClient({ auth: process.env.NOTION_INTEGRATION_SECRET });

    // Extract the 32-char hex ID from whatever is provided (full URL or bare ID)
    const hexMatch = resolvedPageId.match(/([a-f0-9]{32})/i);
    if (!hexMatch) {
      return res.status(400).json({ error: 'Could not find a valid Notion ID. Paste the 32-character ID from the page URL.' });
    }
    const raw = hexMatch[1];
    const databaseId = `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;

    // --- Step 1: retrieve database schema ---
    const existingDb = await notion.databases.retrieve({ database_id: databaseId }) as any;
    const schema: Record<string, string> = {};
    for (const [name, prop] of Object.entries(existingDb.properties ?? {})) {
      schema[name] = (prop as any).type;
    }

    // Find the title property name
    const titlePropName = Object.entries(schema).find(([, t]) => t === 'title')?.[0] ?? 'Name';

    const selectedSet = new Set(columns);

    // --- Step 2: add truly missing columns (only if not already in schema) ---
    const propsToAdd: Record<string, any> = {};
    for (const col of selectedSet) {
      if (col in schema) continue; // already exists, skip
      if (col === '#') continue;   // title handled separately
      // Default types for new columns
      if (['Qty', 'Pallets'].includes(col))          propsToAdd[col] = { number: {} };
      else if (['Plant', 'Type'].includes(col))       propsToAdd[col] = { select: {} };
      else                                            propsToAdd[col] = { rich_text: {} };
    }
    if (Object.keys(propsToAdd).length > 0) {
      await notion.databases.update({ database_id: databaseId, properties: propsToAdd });
      // Merge new columns into schema with their default types
      for (const [col, def] of Object.entries(propsToAdd)) {
        schema[col] = Object.keys(def)[0];
      }
    }

    // Helper: format a value to match the Notion property type
    function toNotionValue(propType: string, value: any): any {
      const str = String(value ?? '');
      switch (propType) {
        case 'title':     return { title:      [{ text: { content: str } }] };
        case 'rich_text': return { rich_text:  [{ text: { content: str } }] };
        case 'number':    return { number: isNaN(parseFloat(str)) ? 0 : parseFloat(str) };
        case 'select':    return str ? { select: { name: str } } : { select: null };
        case 'date': {
          try {
            const d = new Date(value);
            if (!isNaN(d.getTime())) return { date: { start: d.toISOString() } };
          } catch {}
          return { date: null };
        }
        case 'checkbox':  return { checkbox: Boolean(value) };
        default:          return { rich_text:  [{ text: { content: str } }] };
      }
    }

    // --- Step 3: fetch scan history rows ---
    const conditions: string[] = [];
    const params: (string | boolean)[] = [];

    if (date)    { params.push(date);    conditions.push(`DATE(ose.scanned_at) = $${params.length}`); }
    if (scanner) { params.push(scanner); conditions.push(`ose.scanned_by_name = $${params.length}`); }
    if (type === 'regular') conditions.push(`ose.is_extra = false`);
    if (type === 'extra')   conditions.push(`ose.is_extra = true`);
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const n = params.length;
      conditions.push(`(LOWER(COALESCE(ose.item_name,'')) LIKE $${n} OR LOWER(COALESCE(ose.barcode,'')) LIKE $${n} OR LOWER(COALESCE(ose.scanned_by_name,'')) LIKE $${n})`);
    }

    // Only upload rows not yet synced to Notion
    conditions.push('ose.notion_synced_at IS NULL');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const dataRes = await pool.query(
      `SELECT
         ose.id,
         ose.barcode,
         ose.item_name        AS "itemName",
         ose.pallets,
         ose.total_qty        AS "totalQty",
         ose.is_extra         AS "isExtra",
         ose.stv,
         ose.scanned_by_code  AS "scannedByCode",
         ose.scanned_by_name  AS "scannedByName",
         ose.scanned_at       AS "scannedAt",
         ois.csv_file_name    AS "orderName",
         ois.plant
       FROM order_scan_events ose
       JOIN order_import_sessions ois ON ois.id = ose.session_id
       ${where}
       ORDER BY ose.scanned_at ASC
       LIMIT 2000`,
      params,
    );

    const rows = dataRes.rows;

    // --- Step 4: insert rows, formatting each value to match the DB's actual schema ---
    let insertedCount = 0;
    const insertErrors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const h = rows[i];
      try {
        const rowNum = String(i + 1);

        // Map our column names → raw values
        const colValues: Record<string, any> = {
          '#':          rowNum,
          'Scanned By': h.scannedByName ?? '',
          'Code':       h.scannedByCode ?? '',
          'Item':       h.itemName ?? '',
          'Barcode':    h.barcode ?? '',
          'Order':      h.orderName ?? '',
          'Plant':      h.plant || 'Unknown',
          'Qty':        h.totalQty ?? 0,
          'Pallets':    h.pallets != null ? parseFloat(String(h.pallets)) : 0,
          'STV':        h.stv ?? '',
          'Type':       h.isExtra ? 'Extra' : 'Regular',
          'Time':       h.scannedAt ?? null,
        };

        // Always populate the title property first
        const props: Record<string, any> = {
          [titlePropName]: toNotionValue('title', colValues[titlePropName] ?? rowNum),
        };

        // Populate selected columns using the actual schema type
        for (const col of selectedSet) {
          if (col === titlePropName) continue; // already set above
          if (!(col in schema)) continue;       // not in DB, skip
          props[col] = toNotionValue(schema[col], colValues[col]);
        }

        await notion.pages.create({
          parent: { database_id: databaseId },
          properties: props,
        });
        // Mark this row as synced so it won't be re-uploaded
        await pool.query(
          `UPDATE order_scan_events SET notion_synced_at = NOW() WHERE id = $1`,
          [h.id],
        );
        insertedCount++;
      } catch (rowErr: any) {
        console.error(`Row ${i + 1} insert failed:`, rowErr?.message);
        insertErrors.push(`Row ${i + 1}: ${rowErr?.message}`);
        if (insertErrors.length >= 5) break;
      }
    }

    const dbUrl = `https://www.notion.so/${databaseId.replace(/-/g, '')}`;
    return res.json({
      success: true,
      fetched: rows.length,
      uploaded: insertedCount,
      errors: insertErrors,
      databaseId,
      url: dbUrl,
    });
  } catch (error: any) {
    console.error('Error uploading to Notion:', error);
    return res.status(500).json({ error: error?.message ?? 'Failed to upload to Notion' });
  }
});

export default router;
