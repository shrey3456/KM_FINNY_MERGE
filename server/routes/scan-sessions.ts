import { Router, Request, Response } from 'express';
import { format } from 'date-fns';
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
import { getUserPlants } from './order-scan';
import { pushScanHistoryToNotion, saveScanHistoryNotionConfig } from '../services/scanHistoryNotionSync';

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
          WHERE ose.is_extra = true AND ose.barcode <> 'EMPTY_BOX'
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
       WHERE ose.is_extra = true AND ose.barcode <> 'EMPTY_BOX'
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
          AND ose.barcode <> 'EMPTY_BOX'  -- empty boxes aren't stock (see order-scan.ts)
          AND ose.voided IS NOT TRUE
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

// Product exchanges (stock_movements, type='exchange') are unioned in alongside the regular
// order_scan_events rows, mapped onto the same shape — see the "no new table" note on the
// exchange-stock endpoint above. Never modifies/reads back existing scan rows differently;
// exchanges only ever ADD rows to what this endpoint already returned before they existed.
const SCAN_HISTORY_COMBINED_SOURCE = `
  (
    SELECT
      ose.id,
      ose.barcode,
      ose.item_name        AS "itemName",
      ose.pallets,
      ose.total_qty        AS "totalQty",
      ose.items_per_pallet AS "itemsPerPallet",
      ose.loose_qty        AS "looseQty",
      ose.is_extra         AS "isExtra",
      (ose.barcode = 'EMPTY_BOX') AS "isEmptyBox",
      false AS "isExchange",
      CASE WHEN ose.item_name LIKE 'Empty Box: %' THEN SUBSTRING(ose.item_name FROM 12) ELSE NULL END AS "emptyBoxNote",
      ose.stv,
      ose.scanned_by_code  AS "scannedByCode",
      ose.scanned_by_name  AS "scannedByName",
      ose.scanned_at       AS "scannedAt",
      ose.voided,
      ose.voided_at        AS "voidedAt",
      ose.void_reason      AS "voidReason",
      -- Inventory Sr. No for this item (products.new_sr, matched by barcode) so the same item
      -- always carries the same Sr. No here as on the Inventory page. LIMIT 1 avoids row
      -- duplication if a barcode ever appears on more than one product row.
      (SELECT p.new_sr FROM products p WHERE LOWER(p.barcode) = LOWER(ose.barcode) LIMIT 1) AS "srNo",
      ois.csv_file_name    AS "orderName",
      ois.order_date       AS "orderDate",
      ois.plant            AS "plant"
    FROM order_scan_events ose
    JOIN order_import_sessions ois ON ois.id = ose.session_id

    UNION ALL

    SELECT
      (2000000000 + sm.id) AS id,
      sm.barcode,
      (SELECT p.name FROM products p WHERE LOWER(p.barcode) = LOWER(sm.barcode) LIMIT 1) AS "itemName",
      NULL::integer AS pallets,
      sm.qty AS "totalQty",
      NULL::integer AS "itemsPerPallet",
      NULL::integer AS "looseQty",
      false AS "isExtra",
      false AS "isEmptyBox",
      true AS "isExchange",
      NULL::text AS "emptyBoxNote",
      NULL::text AS stv,
      sm.created_by_code AS "scannedByCode",
      (SELECT u.name FROM users u WHERE u.user_code = sm.created_by_code LIMIT 1) AS "scannedByName",
      sm.created_at AS "scannedAt",
      false AS voided,
      NULL::timestamp AS "voidedAt",
      NULL::text AS "voidReason",
      (SELECT p.new_sr FROM products p WHERE LOWER(p.barcode) = LOWER(sm.barcode) LIMIT 1) AS "srNo",
      sm.reason AS "orderName",
      NULL::text AS "orderDate",
      sm.plant AS "plant"
    FROM stock_movements sm
    WHERE sm.type = 'exchange'
  ) combined
`;

// Generic "+ Filter" column engine (client/src/lib/columnFilters.ts) mirrored server-side —
// Scan History is paginated (LIMIT/OFFSET), so unlike Overall Stock's client-side matching,
// these conditions must become real SQL to filter/paginate correctly across the whole result
// set, not just whatever page happens to be loaded. Only columns in this allowlist are ever
// touched by user input — the column id (and its SQL expression) is fixed server-side, so a
// request can never reference an arbitrary column.
const SCAN_HISTORY_FILTER_COLUMNS: Record<string, { sql: string; type: 'text' | 'number' | 'date' }> = {
  stv:       { sql: 'stv',         type: 'text' },
  time:      { sql: '"scannedAt"', type: 'date' },
  plant:     { sql: '"plant"',     type: 'text' },
};

type GenericFilterCondition = { columnIds?: string[]; operator?: string; value?: unknown };

// Appends zero or more SQL clauses (one per condition, columns within a condition OR'd
// together) onto `conditions`/`params` — same shape/semantics as the frontend's matchCondition:
// AND across conditions, OR across the columns picked into one condition.
function applyScanHistoryColumnFilters(filtersParam: string | undefined, conditions: string[], params: any[]) {
  if (!filtersParam) return;
  let parsed: unknown;
  try { parsed = JSON.parse(filtersParam); } catch { return; }
  if (!Array.isArray(parsed)) return;

  for (const raw of parsed as GenericFilterCondition[]) {
    const columnIds = Array.isArray(raw?.columnIds) ? raw.columnIds : [];
    const operator = typeof raw?.operator === 'string' ? raw.operator : '';
    if (columnIds.length === 0 || !operator) continue;

    const colClauses: string[] = [];
    for (const columnId of columnIds) {
      const col = SCAN_HISTORY_FILTER_COLUMNS[columnId];
      if (!col) continue; // not in the allowlist — ignore rather than error
      const clause = buildScanHistoryFilterClause(col, operator, raw.value, params);
      if (clause) colClauses.push(clause);
    }
    if (colClauses.length > 0) conditions.push(`(${colClauses.join(' OR ')})`);
  }
}

function buildScanHistoryFilterClause(
  col: { sql: string; type: 'text' | 'number' | 'date' },
  operator: string,
  value: unknown,
  params: any[],
): string | null {
  const push = (v: any) => { params.push(v); return `$${params.length}`; };

  if (operator === 'in') {
    const values = Array.isArray(value) ? (value as string[]) : [];
    if (values.length === 0) return null;
    if (col.type === 'date') {
      return `(${values.map((v) => `DATE(${col.sql}) = ${push(v)}::date`).join(' OR ')})`;
    }
    if (col.type === 'number') {
      const nums = values.map(Number).filter((n) => !Number.isNaN(n));
      return nums.length ? `${col.sql} = ANY(${push(nums)}::numeric[])` : null;
    }
    return `LOWER(COALESCE(${col.sql}::text,'')) = ANY(${push(values.map((v) => v.toLowerCase()))}::text[])`;
  }

  if (col.type === 'text') {
    const v = typeof value === 'string' ? value : '';
    if (operator === 'empty') return `COALESCE(${col.sql}::text,'') = ''`;
    if (operator === 'contains') return `LOWER(COALESCE(${col.sql}::text,'')) LIKE ${push(`%${v.toLowerCase()}%`)}`;
    if (operator === 'equals') return `LOWER(COALESCE(${col.sql}::text,'')) = ${push(v.toLowerCase())}`;
    return null;
  }

  if (col.type === 'number') {
    if (operator === 'between') {
      const [a, b] = Array.isArray(value) ? (value as string[]) : ['', ''];
      if (a === '' && b === '') return null;
      return `${col.sql} BETWEEN ${push(Number(a) || 0)} AND ${push(Number(b) || 0)}`;
    }
    const n = Number(value);
    if (Number.isNaN(n)) return null;
    if (operator === 'eq') return `${col.sql} = ${push(n)}`;
    if (operator === 'gt') return `${col.sql} > ${push(n)}`;
    if (operator === 'lt') return `${col.sql} < ${push(n)}`;
    return null;
  }

  // date
  if (operator === 'between') {
    const [a, b] = Array.isArray(value) ? (value as string[]) : ['', ''];
    if (!a && !b) return null;
    return `DATE(${col.sql}) BETWEEN ${push(a || '1970-01-01')}::date AND ${push(b || '9999-12-31')}::date`;
  }
  const v = typeof value === 'string' ? value : '';
  if (!v) return null;
  if (operator === 'on') return `DATE(${col.sql}) = ${push(v)}::date`;
  if (operator === 'before') return `${col.sql} < ${push(v)}::date`;
  if (operator === 'after') return `${col.sql} >= ${push(v)}::date + INTERVAL '1 day'`;
  return null;
}

router.get('/reports/scan-history', async (_req: Request, res: Response) => {
  try {
    const req = _req;
    const limit  = Math.max(1, Math.min(100, parseInt(String(req.query.limit  ?? '20'), 10) || 20));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const dateParam    = typeof req.query.date    === 'string' && req.query.date.trim()    ? req.query.date.trim()    : null;
    // Date range (scan date) — from/to, either bound optional. Sent by the Reports page's
    // Overall-Stock-style Date control (single date → from === to). `date` is still honoured for
    // any older/other caller.
    const fromParam    = typeof req.query.from    === 'string' && req.query.from.trim()    ? req.query.from.trim()    : null;
    const toParam      = typeof req.query.to      === 'string' && req.query.to.trim()      ? req.query.to.trim()      : null;
    const scannerParam = typeof req.query.scanner === 'string' && req.query.scanner.trim() ? req.query.scanner.trim() : null;
    const typeParam    = typeof req.query.type    === 'string' && ['regular','extra','empty','exchange'].includes(req.query.type) ? req.query.type : null;
    const searchParam  = typeof req.query.search  === 'string' && req.query.search.trim()  ? req.query.search.trim()  : null;
    const plantParam   = typeof req.query.plant   === 'string' && req.query.plant.trim()   ? req.query.plant.trim()   : null;
    const filtersParam = typeof req.query.filters === 'string' && req.query.filters.trim() ? req.query.filters.trim() : undefined;

    // Plant scoping: admin/super-admin/billing (allowed === null) see every plant; everyone
    // else is restricted to the plant(s) assigned to them on the Users page. A non-admin with
    // no resolvable plant sees nothing rather than accidentally seeing all.
    const allowedPlants = getUserPlants(req.user);

    const conditions: string[] = [];
    const params: any[] = [];

    if (allowedPlants !== null) {
      if (allowedPlants.length === 0) {
        return res.json({ items: [], total: 0, totalBoxes: 0, totalPallets: 0, extraCount: 0, emptyBoxCount: 0, scanners: [], limit, offset });
      }
      params.push(allowedPlants);
      conditions.push(`LOWER("plant") = ANY($${params.length}::text[])`);
    }
    if (plantParam)   { params.push(plantParam.toLowerCase()); conditions.push(`LOWER("plant") = $${params.length}`); }
    if (dateParam)    { params.push(dateParam);    conditions.push(`DATE("scannedAt") = $${params.length}`); }
    if (fromParam)    { params.push(fromParam);    conditions.push(`DATE("scannedAt") >= $${params.length}::date`); }
    if (toParam)      { params.push(toParam);      conditions.push(`DATE("scannedAt") <= $${params.length}::date`); }
    if (scannerParam) { params.push(scannerParam); conditions.push(`"scannedByName" = $${params.length}`); }
    // Empty boxes and exchanges ARE shown in scan history as their own distinct statuses, but
    // they're never product scans — so 'regular'/'extra' filters must exclude both, and the
    // box/pallet totals below exclude them too (they don't count toward order quantity). A
    // dedicated 'empty'/'exchange' filter shows only that one status.
    if (typeParam === 'regular')  conditions.push(`"isExtra" = false AND barcode <> 'EMPTY_BOX' AND NOT "isExchange"`);
    if (typeParam === 'extra')    conditions.push(`"isExtra" = true AND barcode <> 'EMPTY_BOX'`);
    if (typeParam === 'empty')    conditions.push(`barcode = 'EMPTY_BOX'`);
    if (typeParam === 'exchange') conditions.push(`"isExchange" = true`);
    if (searchParam) {
      params.push(`%${searchParam.toLowerCase()}%`);
      const n = params.length;
      conditions.push(`(LOWER(COALESCE("itemName",'')) LIKE $${n} OR LOWER(COALESCE(barcode,'')) LIKE $${n} OR LOWER(COALESCE("scannedByName",'')) LIKE $${n})`);
    }
    applyScanHistoryColumnFilters(filtersParam, conditions, params);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const baseFrom = `FROM ${SCAN_HISTORY_COMBINED_SOURCE} ${where}`;
    // Summary tiles are about genuine scanning activity — always exclude exchanges from them
    // regardless of the active type filter, so "Total Boxes"/"Total Pallets" never mix in a
    // stock-correction quantity.
    const summaryWhere = where
      ? `${where} AND NOT "isExchange"`
      : `WHERE NOT "isExchange"`;
    const summaryFrom = `FROM ${SCAN_HISTORY_COMBINED_SOURCE} ${summaryWhere}`;

    // Destructuring order must track the array below: data, count, summary, column totals, scanners.
    const [dataRes, countRes, summaryRes, columnTotalsRes, scannersRes] = await Promise.all([
      pool.query(
        `SELECT *
         ${baseFrom}
         ORDER BY "scannedAt" DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      pool.query(`SELECT COUNT(*) AS total ${baseFrom}`, params),
      pool.query(
        `SELECT
           COALESCE(SUM("totalQty") FILTER (WHERE barcode <> 'EMPTY_BOX'), 0)  AS "totalBoxes",
           COALESCE(SUM(pallets)    FILTER (WHERE barcode <> 'EMPTY_BOX'), 0)  AS "totalPallets",
           COUNT(*) FILTER (WHERE "isExtra" = true AND barcode <> 'EMPTY_BOX') AS "extraCount",
           COALESCE(SUM("totalQty") FILTER (WHERE barcode = 'EMPTY_BOX'), 0)   AS "emptyBoxCount"
         ${summaryFrom}`,
        params,
      ),
      // Column totals for the Reports table's totals row. Distinct from the tiles above: these
      // cover exactly the rows the table lists (same WHERE — exchanges and empty boxes included)
      // minus voided ones, which the void action promises to exclude from totals. Computed here
      // because the browser only holds one page of rows and cannot sum the set itself.
      pool.query(
        `SELECT
           COALESCE(SUM("totalQty") FILTER (WHERE NOT COALESCE(voided, false)), 0) AS "qtyTotal",
           COALESCE(SUM(pallets)    FILTER (WHERE NOT COALESCE(voided, false)), 0) AS "palletsTotal"
         ${baseFrom}`,
        params,
      ),
      pool.query(
        `SELECT DISTINCT name FROM (
           SELECT scanned_by_name AS name FROM order_scan_events WHERE scanned_by_name IS NOT NULL
           UNION
           SELECT u.name FROM stock_movements sm
             JOIN users u ON u.user_code = sm.created_by_code
             WHERE sm.type = 'exchange' AND u.name IS NOT NULL
         ) s
         ORDER BY name`,
      ),
    ]);

    return res.json({
      items:        dataRes.rows,
      total:        parseInt(countRes.rows[0].total, 10),
      totalBoxes:   parseInt(summaryRes.rows[0].totalBoxes, 10),
      totalPallets: parseFloat(summaryRes.rows[0].totalPallets),
      extraCount:   parseInt(summaryRes.rows[0].extraCount, 10),
      emptyBoxCount: parseInt(summaryRes.rows[0].emptyBoxCount, 10),
      scanners:     scannersRes.rows.map((r: any) => r.name as string),
      qtyTotal:     parseInt(columnTotalsRes.rows[0].qtyTotal, 10),
      palletsTotal: parseFloat(columnTotalsRes.rows[0].palletsTotal),
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error generating scan history:', error);
    return res.status(500).json({ error: 'Failed to generate scan history' });
  }
});

// ── GET /reports/scan-history/filter-values ──────────────────────────────────────────────────
// Every distinct value for every generic "+ Filter" column, in one response — Scan History is
// paginated (only one page of rows ever reaches the browser), so unlike Overall Stock's Values
// checklist (built straight from the fully-loaded rows already in the browser), this has to ask
// the server directly for what values actually exist. Scoped only by plant access (not by the
// other active filters), same as Stock's checklists never re-narrow off client-side filters
// either. Capped per column — scan history can have far more distinct items/barcodes than
// Stock's product catalog, so an unbounded list isn't safe to ship to the browser.
router.get('/reports/scan-history/filter-values', async (req: Request, res: Response) => {
  try {
    const allowedPlants = getUserPlants(req.user);
    if (allowedPlants !== null && allowedPlants.length === 0) {
      const empty: Record<string, { value: string; label: string }[]> = {};
      for (const id of Object.keys(SCAN_HISTORY_FILTER_COLUMNS)) empty[id] = [];
      return res.json(empty);
    }
    const plantWhere = allowedPlants !== null ? `WHERE LOWER("plant") = ANY($1::text[])` : '';
    const plantParams = allowedPlants !== null ? [allowedPlants] : [];

    const entries = Object.entries(SCAN_HISTORY_FILTER_COLUMNS);
    const results = await Promise.all(entries.map(async ([id, col]) => {
      if (col.type === 'date') {
        const { rows } = await pool.query(
          `SELECT DISTINCT DATE(${col.sql})::text AS d
           FROM ${SCAN_HISTORY_COMBINED_SOURCE} ${plantWhere ? `${plantWhere} AND ${col.sql} IS NOT NULL` : `WHERE ${col.sql} IS NOT NULL`}
           ORDER BY d DESC LIMIT 500`,
          plantParams,
        );
        return [id, rows.map((r: any) => ({ value: r.d, label: format(new Date(r.d), 'MMM d, yyyy') }))] as const;
      }
      const { rows } = await pool.query(
        `SELECT DISTINCT ${col.sql}::text AS v
         FROM ${SCAN_HISTORY_COMBINED_SOURCE} ${plantWhere ? `${plantWhere} AND ${col.sql} IS NOT NULL AND ${col.sql}::text <> ''` : `WHERE ${col.sql} IS NOT NULL AND ${col.sql}::text <> ''`}
         ORDER BY ${col.type === 'number' ? `${col.sql}` : 'v'} LIMIT 500`,
        plantParams,
      );
      return [id, rows.map((r: any) => ({
        value: r.v,
        label: col.type === 'number' ? Number(r.v).toLocaleString() : r.v,
      }))] as const;
    }));

    return res.json(Object.fromEntries(results));
  } catch (error) {
    console.error('Error fetching scan history filter values:', error);
    return res.status(500).json({ error: 'Failed to fetch filter values' });
  }
});

// ── Upload scan-history rows into an existing Notion database ────────────────
router.post('/reports/upload-to-notion', requirePageWrite('scan-history'), async (_req: Request, res: Response) => {
  try {
    const { pageId, columns, date, from, to, search, scanner, type, plant } = _req.body as {
      pageId: string;
      columns: string[];
      date?: string;
      from?: string;
      to?: string;
      search?: string;
      scanner?: string;
      type?: string;
      plant?: string;
    };

    const resolvedPageId = (pageId && pageId.trim()) || process.env.SCAN_HISTORY_NOTION_DB_ID || '';
    if (!resolvedPageId || !columns || columns.length === 0) {
      return res.status(400).json({ error: 'No Notion database ID configured. Set SCAN_HISTORY_NOTION_DB_ID in .env or enter it in the dialog.' });
    }

    // Push logic lives in the shared service so this manual upload and the 30-min auto-sync run
    // identical code. Plant scoping mirrors GET /reports/scan-history: admins export any plant;
    // others are limited to their assigned plant(s).
    const result = await pushScanHistoryToNotion({
      pageId: resolvedPageId,
      columns,
      allowedPlants: getUserPlants(_req.user),
      date, from, to, search, scanner, type, plant,
    });

    // Remember this target + column selection so the auto-sync reuses them (best-effort).
    saveScanHistoryNotionConfig(result.databaseId, columns).catch((e) =>
      console.error('Failed to persist scan-history Notion config:', e?.message ?? e));

    return res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Error uploading to Notion:', error);
    return res.status(500).json({ error: error?.message ?? 'Failed to upload to Notion' });
  }
});

// ── Plant-wise stock (Overall Stock page) ─────────────────────────────────
// Reads the live per-plant running totals from product_plant_stock (one row per
// barcode+plant), enriched with product specs. Access is plant-scoped: admin/
// super-admin/billing see every plant; everyone else only the plant(s) assigned to
// them on the Users page (users.plants). Each row carries in_stock (all physical
// boxes, extras included) AND extraQty (the over-order portion, shown separately).
router.get('/reports/plant-stock', async (req: Request, res: Response) => {
  try {
    const allowed = getUserPlants(req.user); // null = admin (all plants)
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const plantParam = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';

    // Non-admin with no resolvable plant → show nothing (never fall through to "all").
    if (allowed !== null && allowed.length === 0) {
      return res.json({ items: [], total: 0, plants: [] });
    }

    // ── Date range → switch data source ──────────────────────────────────────
    // product_plant_stock holds only CURRENT running totals (no history), so a date filter
    // can't come from it. stock_movements is the append-only ledger where every scan writes a
    // dated row, so when a range is given we aggregate that instead. The result deliberately
    // covers ONLY what was received inside the window — earlier stock is not carried in, so
    // the numbers mean "received in this period", not "balance as of".
    //
    // "Date" here means the ORDER's date (order_import_sessions.order_date — the date picked at
    // CSV upload), NOT the real-world moment the box was physically scanned. Those two can differ
    // by days: a CSV dated the 19th may not finish being scanned until the 30th. Every scan-driven
    // row (receive/adjust) carries session_id, which resolves back to that order's date via the
    // join below; only manual Product Exchange rows have no session_id, so they fall back to their
    // own created_at (they aren't tied to any order — revisit later if that needs order-linking too).
    const from = typeof req.query.from === 'string' ? req.query.from.trim() : '';
    const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';
    const extrasOnly = req.query.extrasOnly === 'true' || req.query.extrasOnly === '1';
    const sort = typeof req.query.sort === 'string' ? req.query.sort.trim() : '';
    const dateMode = !!(from || to);

    const params: any[] = [];
    const conds: string[] = [];

    // Date params must be pushed FIRST: they appear earlier in the final SQL text (inside the
    // subquery) than the plant/search conditions, and pg placeholders are positional.
    let sourceSql = 'product_plant_stock';
    if (dateMode) {
      const dateConds: string[] = [];
      if (from) { params.push(from); dateConds.push(`COALESCE(ois.order_date::date, sm.created_at::date) >= $${params.length}::date`); }
      if (to)   { params.push(to);   dateConds.push(`COALESCE(ois.order_date::date, sm.created_at::date) <= $${params.length}::date`); }
      sourceSql = `(
        SELECT sm.barcode,
               sm.plant,
               SUM(sm.qty)::int       AS in_stock,
               SUM(sm.extra_qty)::int AS extra_qty,
               MAX(sm.created_at)     AS updated_at
        FROM stock_movements sm
        LEFT JOIN order_import_sessions ois ON ois.id = sm.session_id
        WHERE ${dateConds.join(' AND ')}
        GROUP BY sm.barcode, sm.plant
        HAVING SUM(sm.qty) <> 0 OR SUM(sm.extra_qty) <> 0
      )`;
    }

    if (allowed !== null) {
      params.push(allowed);
      conds.push(`LOWER(pps.plant) = ANY($${params.length}::text[])`);
    }
    if (extrasOnly) {
      conds.push(`pps.extra_qty > 0`);
    }
    if (plantParam) {
      params.push(plantParam.toLowerCase());
      conds.push(`LOWER(pps.plant) = $${params.length}`); // bounded by allowed set above for non-admins
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const n = params.length;
      conds.push(`(LOWER(COALESCE(p.name, pps.barcode)) LIKE $${n} OR LOWER(pps.barcode) LIKE $${n} OR LOWER(COALESCE(p.sap_code,'')) LIKE $${n} OR LOWER(COALESCE(p.category,'')) LIKE $${n})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT
        pps.barcode,
        pps.plant,
        pps.in_stock                                       AS "inStock",
        pps.extra_qty                                      AS "extraQty",
        COALESCE(p.name, pps.barcode)                      AS "itemName",
        p.item_no                                          AS "itemNo",
        CASE
          WHEN UPPER(pps.plant) LIKE '%VAL%' THEN COALESCE(p.gj_sap, p.sap_code)
          WHEN UPPER(pps.plant) LIKE '%IND%' THEN COALESCE(p.mp_sap, p.sap_code)
          ELSE p.sap_code
        END                                                AS "sapCode",
        p.hsn_code                                         AS "hsnCode",
        p.category,
        p.brand,
        -- Pallet size is a per-STATE fact (products.gj_plt/mp_plt), resolved via which state
        -- this row's plant is in (plants.state) — not a plant-name guess like the sapCode
        -- CASE above still is (that one's untouched, out of scope for this change).
        COALESCE(
          CASE WHEN UPPER(pl.state) = 'GJ' THEN NULLIF(p.gj_plt, 0)
               WHEN UPPER(pl.state) = 'MP' THEN NULLIF(p.mp_plt, 0) END,
          NULLIF(p.items_per_pallet, 0), NULLIF(p.pallets, 0)
        )                                                  AS "itemsPerPallet",
        pps.updated_at                                     AS "lastArrived"
      FROM ${sourceSql} pps
      LEFT JOIN products p ON LOWER(p.barcode) = LOWER(pps.barcode)
      LEFT JOIN plants pl ON LOWER(pl.name) = LOWER(pps.plant)
      ${where}
      ORDER BY ${
        sort === 'stock' ? 'pps.in_stock DESC, "itemName" ASC'
        : sort === 'extra' ? 'pps.extra_qty DESC, "itemName" ASC'
        : '"itemName" ASC, pps.plant ASC'
      }
    `, params);

    const items = rows.map((r: any, i: number) => {
      const ipp = r.itemsPerPallet != null ? Number(r.itemsPerPallet) : 0;
      return {
        srNo: i + 1,
        barcode: r.barcode,
        plant: r.plant,
        itemName: r.itemName,
        itemNo: r.itemNo ?? null,
        sapCode: r.sapCode ?? null,
        hsnCode: r.hsnCode ?? null,
        category: r.category ?? null,
        brand: r.brand ?? null,
        itemsPerPallet: ipp || null,
        inStock: Number(r.inStock) || 0,
        extraQty: Number(r.extraQty) || 0,
        pallets: ipp > 0 ? parseFloat((Number(r.inStock) / ipp).toFixed(2)) : null,
        extraPallets: ipp > 0 ? parseFloat((Number(r.extraQty) / ipp).toFixed(2)) : null,
        lastArrived: r.lastArrived ?? null,
      };
    });

    // ── Expected Qty — sum of every CSV's ordered quantity for the order date(s) currently
    // relevant per plant ──────────────────────────────────────────────────────────────────
    // Explicit date filter (from/to pin down one day, e.g. the "Today"/"Yesterday" presets or
    // the user filling in just `from`): that ONE date applies to every plant, same as before.
    // No filter at all: each plant uses its OWN currently ACTIVE session's order date instead
    // of one shared date — Valsad might be actively scanning the 19th while Indore is still on
    // the 10th, and each plant's Expected reflects its own reality. This replaced two earlier,
    // broken defaults: "literal today" (usually empty — most days nothing's uploaded yet) and
    // before that "oldest pending order across ALL plants" (which silently applied ONE plant's
    // backlog date to every plant, pulling in unrelated already-completed orders that happened
    // to share that date — see the 7180-vs-1940 mismatch this replaced). "All" plants now sums
    // each plant's own active-date total — never one date force-applied across plants that
    // aren't even on it.
    let singleDate: string | null = null;   // set only when exactly one date is in play — what the client shows as "(date)" in the tile label.
    let activePairs: { plant: string; orderDate: string }[] = [];
    if (from && (!to || to === from)) {
      singleDate = from;
    } else if (!from && !to) {
      const activeParams: any[] = [];
      const activeConds: string[] = [`scan_status = 'active'`, 'is_deleted = false'];
      if (allowed !== null) { activeParams.push(allowed); activeConds.push(`LOWER(plant) = ANY($${activeParams.length}::text[])`); }
      if (plantParam) { activeParams.push(plantParam.toLowerCase()); activeConds.push(`LOWER(plant) = $${activeParams.length}`); }
      const { rows: activeRows } = await pool.query(
        `SELECT LOWER(plant) AS plant, order_date AS "orderDate" FROM order_import_sessions WHERE ${activeConds.join(' AND ')}`,
        activeParams,
      );
      activePairs = activeRows.map((r: any) => ({ plant: r.plant, orderDate: r.orderDate }));
      const distinctDates = new Set(activePairs.map((p) => p.orderDate));
      if (distinctDates.size === 1) singleDate = activePairs[0]?.orderDate ?? null;
    }
    // Surfaced to the client so "All" can label itself sensibly even when the plants
    // underneath it are on different active dates (no single date to print in that case).
    const activeDatesByPlant: Record<string, string> = {};
    for (const p of activePairs) activeDatesByPlant[p.plant] = p.orderDate;

    const expectedByKey = new Map<string, number>();
    let expectedTotal = 0;
    const expectedOnlyRows: typeof items = [];

    // Shared by both query shapes below: turns raw (barcode, plant, expectedQty) rows into
    // expectedByKey/expectedTotal, plus synthetic zero-stock rows for barcodes that were
    // ordered but have nothing scanned/stocked yet at all (so the full ordered qty is still
    // visible before a single box is scanned).
    // Same per-state pallet-size resolution as the main query above (plants.state, not a
    // plant-name guess) — fetched once here since applyExpectedRows can run more than once.
    const { rows: plantStateRows } = await pool.query(`SELECT name, state FROM plants`);
    const plantStateByName = new Map<string, string>(
      plantStateRows.map((p: any) => [String(p.name ?? '').toLowerCase(), String(p.state ?? '').toUpperCase()]),
    );

    async function applyExpectedRows(expRows: any[]) {
      const unmatchedBarcodes = new Set<string>();
      for (const r of expRows) {
        const key = `${(r.barcode ?? '').toLowerCase()}::${(r.plant ?? '').toLowerCase()}`;
        const qty = Number(r.expectedQty) || 0;
        expectedByKey.set(key, qty);
        expectedTotal += qty;
        if (r.barcode) unmatchedBarcodes.add(r.barcode);
      }
      const barcodesNeedingLookup = [...unmatchedBarcodes];
      const productByBarcode = new Map<string, any>();
      if (barcodesNeedingLookup.length > 0) {
        const { rows: prodRows } = await pool.query(
          `SELECT barcode, name, item_no, sap_code, gj_sap, mp_sap, hsn_code, category, brand,
                  items_per_pallet, gj_plt, mp_plt, pallets
           FROM products WHERE LOWER(barcode) = ANY($1::text[])`,
          [barcodesNeedingLookup.map((b) => b.toLowerCase())],
        );
        for (const p of prodRows as any[]) productByBarcode.set(String(p.barcode).toLowerCase(), p);
      }
      for (const r of expRows) {
        const key = `${(r.barcode ?? '').toLowerCase()}::${(r.plant ?? '').toLowerCase()}`;
        if (items.some((it: any) => `${(it.barcode ?? '').toLowerCase()}::${(it.plant ?? '').toLowerCase()}` === key)) continue;
        const p = productByBarcode.get((r.barcode ?? '').toLowerCase());
        // Untouched, out of scope for this change — sapCode still resolves by plant-name guess.
        const plantUpper = String(r.plant ?? '').toUpperCase();
        const sapCode = p ? (plantUpper.includes('VAL') ? (p.gj_sap ?? p.sap_code) : plantUpper.includes('IND') ? (p.mp_sap ?? p.sap_code) : p.sap_code) : null;
        const state = plantStateByName.get((r.plant ?? '').toLowerCase());
        const ipp = p ? Number(
          (state === 'GJ' && p.gj_plt) || (state === 'MP' && p.mp_plt)
            ? (state === 'GJ' ? p.gj_plt : p.mp_plt)
            : (p.items_per_pallet || p.pallets || 0)
        ) : 0;
        expectedOnlyRows.push({
          srNo: 0, barcode: r.barcode, plant: r.plant,
          itemName: p?.name ?? r.barcode, itemNo: p?.item_no ?? null, sapCode: sapCode ?? null,
          hsnCode: p?.hsn_code ?? null, category: p?.category ?? null, brand: p?.brand ?? null,
          itemsPerPallet: ipp || null, inStock: 0, extraQty: 0,
          pallets: null, extraPallets: null, lastArrived: null,
        } as any);
      }
    }

    if (singleDate) {
      // Explicit filter, or every active plant coincidentally on the same date — one shared date.
      const expParams: any[] = [singleDate];
      const expConds: string[] = ['ois.order_date = $1', 'ois.is_deleted = false'];
      if (allowed !== null) { expParams.push(allowed); expConds.push(`LOWER(oii.plant) = ANY($${expParams.length}::text[])`); }
      if (plantParam) { expParams.push(plantParam.toLowerCase()); expConds.push(`LOWER(oii.plant) = $${expParams.length}`); }
      const { rows: expRows } = await pool.query(`
        SELECT oii.barcode, oii.plant, SUM(oii.quantity)::int AS "expectedQty"
        FROM order_import_items oii
        JOIN order_import_sessions ois ON ois.id = oii.session_id
        WHERE ${expConds.join(' AND ')}
        GROUP BY oii.barcode, oii.plant
        HAVING SUM(oii.quantity) <> 0
      `, expParams);
      await applyExpectedRows(expRows);
    } else if (activePairs.length > 0) {
      // Multiple plants on genuinely different active dates — join each item's session against
      // its OWN plant's active date instead of one date applied everywhere.
      const expParams: any[] = [];
      const valuesSql = activePairs
        .map((p) => { expParams.push(p.plant, p.orderDate); return `($${expParams.length - 1}::text, $${expParams.length}::text)`; })
        .join(', ');
      const { rows: expRows } = await pool.query(`
        SELECT oii.barcode, oii.plant, SUM(oii.quantity)::int AS "expectedQty"
        FROM order_import_items oii
        JOIN order_import_sessions ois ON ois.id = oii.session_id
        JOIN (VALUES ${valuesSql}) AS active(plant, order_date) ON LOWER(ois.plant) = active.plant AND ois.order_date = active.order_date
        WHERE ois.is_deleted = false
        GROUP BY oii.barcode, oii.plant
        HAVING SUM(oii.quantity) <> 0
      `, expParams);
      await applyExpectedRows(expRows);
    }

    const hasExpected = singleDate != null || activePairs.length > 0;
    const itemsWithExpected = hasExpected
      ? [...items, ...expectedOnlyRows].map((it: any) => ({
          ...it,
          expectedQty: expectedByKey.get(`${(it.barcode ?? '').toLowerCase()}::${(it.plant ?? '').toLowerCase()}`) ?? null,
        }))
      : items;

    // dateMode tells the client that inStock/extraQty mean "received in the selected window",
    // not "total on hand", so it can label the columns honestly.
    // Empty boxes are received physical boxes with no product/stock — a distinct status, not
    // inventory. Surface them here as a separate per-plant reconciliation figure (never mixed
    // into inStock). Scoped to the same plants as the stock rows above.
    const ebParams: any[] = [];
    const ebConds: string[] = [`ose.barcode = 'EMPTY_BOX'`, 'ose.voided IS NOT TRUE'];
    if (allowed !== null) { ebParams.push(allowed); ebConds.push(`LOWER(ois.plant) = ANY($${ebParams.length}::text[])`); }
    if (plantParam)       { ebParams.push(plantParam.toLowerCase()); ebConds.push(`LOWER(ois.plant) = $${ebParams.length}`); }
    const { rows: ebRows } = await pool.query(`
      SELECT ois.plant, COALESCE(SUM(ose.total_qty), 0)::int AS "qty", COUNT(*)::int AS "count"
      FROM order_scan_events ose
      JOIN order_import_sessions ois ON ois.id = ose.session_id
      WHERE ${ebConds.join(' AND ')}
      GROUP BY ois.plant
    `, ebParams);
    const emptyBoxByPlant = ebRows.map((r: any) => ({ plant: r.plant, qty: r.qty, count: r.count }));
    const emptyBoxTotal = ebRows.reduce((s: number, r: any) => s + Number(r.qty), 0);

    res.json({
      items: itemsWithExpected, total: itemsWithExpected.length, plants: allowed,
      emptyBoxByPlant, emptyBoxTotal, dateMode, from: from || null, to: to || null,
      // expectedDate: one date when it applies to everything (explicit filter, single plant,
      // or every active plant coincidentally matches) — null when plants are on different
      // active dates, in which case activeDatesByPlant carries each plant's own date instead.
      expectedDate: singleDate, expectedTotal: hasExpected ? expectedTotal : null,
      activeDatesByPlant,
    });
  } catch (error) {
    console.error('Error generating plant stock report:', error);
    res.status(500).json({ error: 'Failed to generate plant stock report' });
  }
});

// ── POST /api/scan-sessions/reports/exchange-stock ───────────────────────────────────────────
// Manual stock swap between two products at ONE plant — "this physical stock was actually
// product B, not product A". Admin, or anyone granted Write Access to the "overall-stock" page.
// No dedicated table: reuses the existing stock_movements ledger with a new type ('exchange')
// instead of adding schema — two rows are written (− on fromBarcode, + on toBarcode), which is
// also all the Scan History "Exchange" filter reads from. Never touches order_scan_events, so
// existing scan history is untouched.
router.post('/reports/exchange-stock', requirePageWrite('overall-stock'), async (req: Request, res: Response) => {
  const fromBarcode = typeof req.body?.fromBarcode === 'string' ? req.body.fromBarcode.trim() : '';
  const toBarcode    = typeof req.body?.toBarcode   === 'string' ? req.body.toBarcode.trim()   : '';
  const plant        = typeof req.body?.plant       === 'string' ? req.body.plant.trim()       : '';
  const removeQty     = Number(req.body?.removeQty);
  const addQty        = Number(req.body?.addQty);
  const userNote       = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';

  if (!fromBarcode || !toBarcode || !plant) {
    return res.status(400).json({ message: 'fromBarcode, toBarcode and plant are required' });
  }
  if (fromBarcode.toLowerCase() === toBarcode.toLowerCase()) {
    return res.status(400).json({ message: 'Cannot exchange a product with itself' });
  }
  if (!Number.isFinite(removeQty) || removeQty <= 0 || !Number.isFinite(addQty) || addQty <= 0) {
    return res.status(400).json({ message: 'removeQty and addQty must both be greater than 0' });
  }

  // Plant scoping — requirePageWrite above only checks the "overall-stock" grant, not which
  // plant(s) it applies to, so a non-admin restricted to specific plants still can't exchange
  // stock at a plant they don't have access to.
  const allowedPlants = getUserPlants(req.user);
  if (allowedPlants !== null && !allowedPlants.includes(plant.toLowerCase())) {
    return res.status(403).json({ message: 'Access denied for this plant' });
  }

  const userCode = (req.user as any)?.userCode ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const [fromProduct, toProduct] = await Promise.all([
      client.query(`SELECT name FROM products WHERE LOWER(barcode) = LOWER($1) LIMIT 1`, [fromBarcode]),
      client.query(`SELECT name FROM products WHERE LOWER(barcode) = LOWER($1) LIMIT 1`, [toBarcode]),
    ]);
    if (!fromProduct.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: `Product not found for barcode ${fromBarcode}` });
    }
    if (!toProduct.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: `Product not found for barcode ${toBarcode}` });
    }
    const fromName = fromProduct.rows[0].name as string;
    const toName = toProduct.rows[0].name as string;

    const { rows: stockRows } = await client.query(
      `SELECT in_stock FROM product_plant_stock WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2) FOR UPDATE`,
      [fromBarcode, plant],
    );
    const currentStock = Number(stockRows[0]?.in_stock ?? 0);
    if (currentStock < removeQty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Only ${currentStock} of "${fromName}" in stock at ${plant} — can't remove ${removeQty}.` });
    }

    // Remove from source
    await client.query(
      `UPDATE product_plant_stock SET in_stock = in_stock - $1, updated_at = NOW() WHERE LOWER(barcode) = LOWER($2) AND LOWER(plant) = LOWER($3)`,
      [removeQty, fromBarcode, plant],
    );
    await client.query(
      `UPDATE products SET in_stock = GREATEST(0, COALESCE(in_stock, 0) - $1) WHERE LOWER(barcode) = LOWER($2)`,
      [removeQty, fromBarcode],
    );

    // Add to target
    await client.query(
      `INSERT INTO product_plant_stock (barcode, plant, in_stock, extra_qty, updated_at)
       VALUES ($1, $2, $3, 0, NOW())
       ON CONFLICT (barcode, plant) DO UPDATE
         SET in_stock = product_plant_stock.in_stock + EXCLUDED.in_stock, updated_at = NOW()`,
      [toBarcode, plant, addQty],
    );
    await client.query(
      `UPDATE products SET in_stock = COALESCE(in_stock, 0) + $1 WHERE LOWER(barcode) = LOWER($2)`,
      [addQty, toBarcode],
    );

    // Audit ledger — two rows, each stands on its own (no linking column needed). This is also
    // the exact source Scan History's "Exchange" filter reads from.
    const fromReason = `Exchanged ${removeQty} for ${addQty} × ${toName} (${toBarcode})${userNote ? ` — ${userNote}` : ''}`;
    const toReason = `Exchanged ${addQty} from ${removeQty} × ${fromName} (${fromBarcode})${userNote ? ` — ${userNote}` : ''}`;
    await client.query(
      `INSERT INTO stock_movements (barcode, plant, qty, extra_qty, type, reason, created_by_code, created_at)
       VALUES ($1, $2, $3, 0, 'exchange', $4, $5, NOW())`,
      [fromBarcode, plant, -removeQty, fromReason, userCode],
    );
    await client.query(
      `INSERT INTO stock_movements (barcode, plant, qty, extra_qty, type, reason, created_by_code, created_at)
       VALUES ($1, $2, $3, 0, 'exchange', $4, $5, NOW())`,
      [toBarcode, plant, addQty, toReason, userCode],
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      from: { barcode: fromBarcode, name: fromName, removedQty: removeQty },
      to: { barcode: toBarcode, name: toName, addedQty: addQty },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error exchanging stock:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to exchange stock' });
  } finally {
    client.release();
  }
});

// ── GET /api/scan-sessions/reports/stock-movements?barcode=X&plant=Y ────────────────────────
// Arrival history for ONE item at ONE plant — powers the "click a row in Overall Stock" drill
// down: every dated entry from the stock_movements ledger (the same append-only source the
// plant-stock report's date-range mode reads from), newest first, with the originating
// CSV/order attached when the entry came from a scan (session_id is null for anything that
// isn't order-scan sourced).
router.get('/reports/stock-movements', async (req: Request, res: Response) => {
  try {
    const barcode = typeof req.query.barcode === 'string' ? req.query.barcode.trim() : '';
    const plant = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
    if (!barcode || !plant) {
      return res.status(400).json({ message: 'barcode and plant are required' });
    }

    // Same plant scoping as every other report here: admins see any plant, everyone else is
    // limited to their assigned plant(s).
    const allowed = getUserPlants(req.user);
    if (allowed !== null && !allowed.includes(plant.toLowerCase())) {
      return res.status(403).json({ message: 'Access denied for this plant' });
    }

    const { rows } = await pool.query(`
      SELECT
        sm.id, sm.qty, sm.extra_qty AS "extraQty", sm.type, sm.reason,
        sm.created_at AS "arrivedAt",
        ois.csv_file_name AS "orderName", ois.order_date AS "orderDate", ois.part_index AS "partIndex"
      FROM stock_movements sm
      LEFT JOIN order_import_sessions ois ON ois.id = sm.session_id
      WHERE LOWER(sm.barcode) = LOWER($1) AND LOWER(sm.plant) = LOWER($2)
      ORDER BY sm.created_at DESC
      LIMIT 500
    `, [barcode, plant]);

    res.json({ items: rows });
  } catch (error) {
    console.error('Error fetching stock movement history:', error);
    res.status(500).json({ error: 'Failed to fetch stock movement history' });
  }
});

export default router;
