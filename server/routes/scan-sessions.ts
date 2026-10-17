import { Router, Request, Response } from 'express';
import { v2Adjust, findLineForProduct, lockLineStock } from '../lib/stockV2';
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
import { eq, desc, inArray, count, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requirePageWrite } from '../lib/pageAccess';
import { getUserPlants } from './order-scan';
import { applyColumnFiltersToSql, type SqlFilterColumn } from '../lib/columnFilterSql';
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
        // No general SAP: the product's own state SAPs.
        productSapCode: sql<string | null>`COALESCE(${products.gjSap}, ${products.mpSap}, ${products.upSap})`,
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
            -- Only GJ PLT/MP PLT count as a defined pallet size (not "Packets"/items_per_pallet
            -- or the generic "pallets" column) — NULL here means undefined, and the grouped
            -- aggregation below falls back to this barcode's own total quantity.
            CASE WHEN UPPER(pl_old.state) = 'GJ' THEN NULLIF(COALESCE(p.gj_plt, p_bc.gj_plt), 0)
                 WHEN UPPER(pl_old.state) = 'MP' THEN NULLIF(COALESCE(p.mp_plt, p_bc.mp_plt), 0) END AS ipp,
            COALESCE(p.gj_sap, p.mp_sap, p.up_sap, p_bc.gj_sap, p_bc.mp_sap, p_bc.up_sap) AS sap_code,
            COALESCE(p.hsn_code,  p_bc.hsn_code)                           AS hsn_code,
            COALESCE(p.category,  p_bc.category)                           AS category,
            COALESCE(p.brand,     p_bc.brand)                              AS brand
          FROM scan_session_extras se
          JOIN scan_sessions ss ON ss.id = se.session_id
          LEFT JOIN plants pl_old ON LOWER(pl_old.name) = LOWER(ss.plant)
          LEFT JOIN products p    ON p.id    = se.product_id
          LEFT JOIN products p_bc ON p.id IS NULL
                                  AND p_bc.barcode IS NOT NULL
                                  AND LOWER(TRIM(p_bc.barcode)) = LOWER(TRIM(se.code))
          ${oldDateWhere}
        ),
        new_e AS (
          SELECT
            LOWER(COALESCE(ose.barcode, ''))                        AS norm_bc,
            COALESCE(ose.barcode, '')                               AS barcode,
            COALESCE(p.name, ose.item_name, ose.barcode)            AS item_name,
            COALESCE(ose.total_qty, 0)                              AS qty,
            ose.scanned_at,
            CASE WHEN UPPER(pl_new.state) = 'GJ' THEN NULLIF(p.gj_plt, 0)
                 WHEN UPPER(pl_new.state) = 'MP' THEN NULLIF(p.mp_plt, 0) END AS ipp,
            CASE
              WHEN UPPER(pl_new.state) = 'GJ' THEN p.gj_sap
              WHEN UPPER(pl_new.state) = 'MP' THEN p.mp_sap
              WHEN UPPER(pl_new.state) = 'UP' THEN p.up_sap
              ELSE NULL
            END                                                     AS sap_code,
            p.hsn_code                                              AS hsn_code,
            p.category                                              AS category,
            p.brand                                                 AS brand
          FROM order_scan_events ose
          JOIN  order_import_sessions ois ON ois.id = ose.session_id
          LEFT JOIN plants pl_new ON LOWER(pl_new.name) = LOWER(ois.plant)
          LEFT JOIN products p ON LOWER(TRIM(p.barcode)) = LOWER(TRIM(ose.barcode))
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
            -- No GJ/MP PLT defined for this barcode — treat it as exactly one pallet sized
            -- to its own total quantity, rather than leaving the figure blank.
            CASE WHEN MAX(ipp) > 0
              THEN ROUND(SUM(qty)::numeric / MAX(ipp), 2)
              ELSE ROUND(SUM(qty)::numeric / GREATEST(SUM(qty), 1), 2)
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
         -- Only GJ PLT/MP PLT count as a defined pallet size; otherwise this row is treated
         -- as exactly one pallet sized to its own quantity rather than showing blank.
         CASE
           WHEN UPPER(pl.state) = 'GJ' AND COALESCE(p.gj_plt, 0) > 0
             THEN ROUND(CAST(se.quantity AS NUMERIC) / p.gj_plt, 2)
           WHEN UPPER(pl.state) = 'MP' AND COALESCE(p.mp_plt, 0) > 0
             THEN ROUND(CAST(se.quantity AS NUMERIC) / p.mp_plt, 2)
           ELSE ROUND(CAST(se.quantity AS NUMERIC) / GREATEST(se.quantity, 1), 2)
         END                  AS pallets
       FROM scan_session_extras se
       INNER JOIN scan_sessions ss ON se.session_id = ss.id
       LEFT  JOIN plants pl ON LOWER(pl.name) = LOWER(ss.plant)
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
         -- ose.pallets/ose.items_per_pallet are real recorded-at-scan-time values (the latter
         -- already resolved via GJ/MP PLT or an expected-qty fallback — see order-scan.ts's
         -- resolvePalletSizeOrQty); only pre-existing rows from before that fix need the
         -- state-aware fallback here, and anything left over defaults to one pallet = its own qty.
         CASE
           WHEN COALESCE(ose.pallets, 0) > 0
             THEN ROUND(CAST(ose.pallets AS NUMERIC), 2)
           WHEN COALESCE(ose.items_per_pallet, 0) > 0
             THEN ROUND(CAST(ose.total_qty AS NUMERIC) / ose.items_per_pallet, 2)
           WHEN UPPER(pl.state) = 'GJ' AND COALESCE(p.gj_plt, 0) > 0
             THEN ROUND(CAST(ose.total_qty AS NUMERIC) / p.gj_plt, 2)
           WHEN UPPER(pl.state) = 'MP' AND COALESCE(p.mp_plt, 0) > 0
             THEN ROUND(CAST(ose.total_qty AS NUMERIC) / p.mp_plt, 2)
           ELSE ROUND(CAST(ose.total_qty AS NUMERIC) / GREATEST(ose.total_qty, 1), 2)
         END                                  AS pallets
       FROM order_scan_events ose
       INNER JOIN order_import_sessions ois ON ois.id = ose.session_id
       LEFT  JOIN plants pl ON LOWER(pl.name) = LOWER(ois.plant)
       LEFT  JOIN products p ON LOWER(TRIM(p.barcode)) = LOWER(TRIM(ose.barcode))
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

// Return configured Notion DB ID (masked for display)
router.get('/reports/notion-config', (_req: Request, res: Response) => {
  const raw = process.env.SCAN_HISTORY_NOTION_DB_ID ?? '';
  return res.json({ dbId: raw || null });
});

// Stock Overview corrections (the book's ledger: Adjust, Opening, Clear, Exchange) are unioned in alongside the scan events (Order Scan, Loading,
// Unloading, Sort picks), mapped onto the same shape - the "Stock Adjust" rows.
const SCAN_HISTORY_COMBINED_SOURCE = `
  (
    -- Item name / Sr. No / order date / user name used to be looked up with a correlated
    -- sub-SELECT per row — and because products.barcode is matched through LOWER(TRIM(...)), no
    -- index could help, so every row of every branch meant a fresh scan of products. On a page
    -- that also polls itself, that was the lag. The same lookups are prepared once here and
    -- joined, which turns thousands of little scans into one hash join per branch.
    WITH product_by_barcode AS (
      SELECT LOWER(TRIM(barcode)) AS bkey, MIN(new_sr) AS new_sr, MIN(name) AS name
      FROM products WHERE barcode IS NOT NULL GROUP BY LOWER(TRIM(barcode))
    ),
    slip_order_date AS (
      SELECT order_number, MIN(order_date) AS order_date FROM proforma_slips GROUP BY order_number
    ),
    user_name AS (
      SELECT user_code, MIN(name) AS name FROM users GROUP BY user_code
    )
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
      false AS "isDispatch",
      false AS "isUnload",
      -- Set by a qty edit, not a fresh scan ("Scan Adjust").
      COALESCE(ose.is_adjust, false) AS "isAdjust",
      -- Which page wrote the row. The flags above say what KIND of entry it is; this says where it
      -- came from, and the two together make the Type label ("Scan Extra", "Load Adjust", …).
      -- Needed on its own because a scan row and a stock-ledger row can carry identical flags.
      'scan' AS "sourceKind",
      NULL::text AS "purchasePlant",
      CASE WHEN ose.item_name LIKE 'Empty Box: %' THEN SUBSTRING(ose.item_name FROM 12) ELSE NULL END AS "emptyBoxNote",
      ose.stv,
      ose.scanned_by_code  AS "scannedByCode",
      ose.scanned_by_name  AS "scannedByName",
      ose.scanned_at       AS "scannedAt",
      -- When this row was CORRECTED, if it was. scannedAt stays the original scan's own time.
      ose.adjusted_at      AS "adjustedAt",
      ose.voided,
      ose.voided_at        AS "voidedAt",
      ose.void_reason      AS "voidReason",
      vun.name             AS "voidedByName",
      -- Inventory Sr. No for this item (products.new_sr, matched by barcode) so the same item
      -- always carries the same Sr. No here as on the Inventory page. One row per barcode, so a
      -- barcode sitting on more than one product row can never duplicate the event.
      pb.new_sr            AS "srNo",
      ois.csv_file_name    AS "orderName",
      ois.order_date       AS "orderDate",
      ois.plant            AS "plant",
      NULL::text           AS "sapCode"
    FROM order_scan_events ose
    JOIN order_import_sessions ois ON ois.id = ose.session_id
    LEFT JOIN product_by_barcode pb ON pb.bkey = LOWER(TRIM(ose.barcode))
    LEFT JOIN user_name vun ON vun.user_code = ose.voided_by_code
    WHERE NOT COALESCE(ose.hidden_in_history, false)

    UNION ALL

    -- Loading page's item-scanning history (server/routes/loading.ts) — each row is a confirmed
    -- scan that actually removed stock onto a vehicle for a proforma order ("Loaded"/"Loaded
    -- Extra" in the Type column below), distinct from a receiving scan (which adds stock) or an
    -- exchange correction. id offset (3000000000+) keeps it out of both other branches' id space,
    -- since Void (order_scan_events-only) and any id-based lookup must never collide across them.
    SELECT
      (3000000000 + lse.id) AS id,
      lse.barcode,
      lse.item_name         AS "itemName",
      lse.pallets,
      lse.total_qty         AS "totalQty",
      NULL::integer AS "itemsPerPallet",
      lse.loose_qty         AS "looseQty",
      lse.is_extra          AS "isExtra",
      false AS "isEmptyBox",
      false AS "isExchange",
      true AS "isDispatch",
      false AS "isUnload",
      -- The Loading Items table's +/- corrections ("Load Adjust"); still isDispatch.
      COALESCE(lse.is_adjust, false) AS "isAdjust",
      'loading' AS "sourceKind",
      NULL::text AS "purchasePlant",
      NULL::text AS "emptyBoxNote",
      lse.stv,
      lse.scanned_by_code   AS "scannedByCode",
      lse.scanned_by_name   AS "scannedByName",
      lse.scanned_at        AS "scannedAt",
      lse.adjusted_at       AS "adjustedAt",
      COALESCE(lse.voided, false) AS voided,
      lse.voided_at         AS "voidedAt",
      lse.void_reason       AS "voidReason",
      vun.name              AS "voidedByName",
      pb.new_sr AS "srNo",
      lse.order_number AS "orderName",
      sod.order_date::text AS "orderDate",
      lse.plant AS "plant",
      lse.sap_code AS "sapCode"
    FROM loading_scan_events lse
    LEFT JOIN product_by_barcode pb ON pb.bkey = LOWER(TRIM(lse.barcode))
    LEFT JOIN slip_order_date sod ON sod.order_number = lse.order_number
    LEFT JOIN user_name vun ON vun.user_code = lse.voided_by_code
    WHERE NOT COALESCE(lse.hidden_in_history, false)

    UNION ALL

    -- Unloading page's own scan history (server/routes/unloading.ts) — each row is a confirmed
    -- scan that received stock for a vehicle+date batch ("Unloaded"/"Unloaded Extra" in the Type
    -- column below). id offset (4000000000+) keeps it out of every other branch's id space, same
    -- reasoning as Loading's 3000000000+ above.
    SELECT
      (4000000000 + use.id) AS id,
      use.barcode,
      use.item_name         AS "itemName",
      use.pallets,
      use.total_qty         AS "totalQty",
      NULL::integer AS "itemsPerPallet",
      use.loose_qty         AS "looseQty",
      use.is_extra          AS "isExtra",
      false AS "isEmptyBox",
      false AS "isExchange",
      false AS "isDispatch",
      true AS "isUnload",
      -- Set by a qty edit, not a fresh scan ("Unload Adjust").
      COALESCE(use.is_adjust, false) AS "isAdjust",
      'unloading' AS "sourceKind",
      uis.purchase_plant AS "purchasePlant",
      NULL::text AS "emptyBoxNote",
      use.stv,
      use.scanned_by_code   AS "scannedByCode",
      use.scanned_by_name   AS "scannedByName",
      use.scanned_at        AS "scannedAt",
      use.adjusted_at       AS "adjustedAt",
      COALESCE(use.voided, false) AS voided,
      use.voided_at         AS "voidedAt",
      use.void_reason       AS "voidReason",
      vun.name              AS "voidedByName",
      pb.new_sr AS "srNo",
      use.vehicle_number AS "orderName",
      uis.order_date AS "orderDate",
      use.plant AS "plant",
      NULL::text AS "sapCode"
    FROM unload_scan_events use
    JOIN unload_import_sessions uis ON uis.id = use.session_id
    LEFT JOIN product_by_barcode pb ON pb.bkey = LOWER(TRIM(use.barcode))
    LEFT JOIN user_name vun ON vun.user_code = use.voided_by_code
    WHERE NOT COALESCE(use.hidden_in_history, false)

    UNION ALL

    -- Stock Overview corrections: a manual Adjust, an Opening entry, a Clear, a product Exchange - every row of the book's ledger. They belong to no
    -- scanning page, so they read as "Stock Adjust" (or "Stock Exchange"). totalQty is the signed change to Stock (+added / -removed).
    -- id offset 5000000000+ keeps it out of every other branch's id space.
    SELECT
      (5000000000 + sl.id) AS id,
      ln.barcode,
      ln.item_name AS "itemName",
      NULL::integer AS pallets,
      sl.qty AS "totalQty",
      NULL::integer AS "itemsPerPallet",
      NULL::integer AS "looseQty",
      false AS "isExtra",
      false AS "isEmptyBox",
      (sl.kind = 'exchange') AS "isExchange",
      false AS "isDispatch",
      false AS "isUnload",
      (sl.kind <> 'exchange') AS "isAdjust",
      'stock' AS "sourceKind",
      NULL::text AS "purchasePlant",
      NULL::text AS "emptyBoxNote",
      NULL::text AS stv,
      sl.created_by_code AS "scannedByCode",
      un.name AS "scannedByName",
      sl.created_at AS "scannedAt",
      NULL::timestamp AS "adjustedAt",
      false AS voided,
      NULL::timestamp AS "voidedAt",
      NULL::text AS "voidReason",
      NULL::text AS "voidedByName",
      COALESCE(ln.sr_no, pb.new_sr) AS "srNo",
      sl.reason AS "orderName",
      NULL::text AS "orderDate",
      ln.plant AS "plant",
      NULL::text AS "sapCode"
    FROM stock_v2_ledger sl
    JOIN stock_v2_lines ln ON ln.id = sl.line_id
    LEFT JOIN product_by_barcode pb ON pb.bkey = LOWER(TRIM(ln.barcode))
    LEFT JOIN user_name un ON un.user_code = sl.created_by_code

    UNION ALL

    -- Sort Slip picks (server/routes/sort-slips.ts) — "this much has been brought to the
    -- platform", typed in by a loader rather than scanned. They move no stock and are NOT a load:
    -- they carry their own sourceKind so they read as "Sort Pick" here and stay out of the
    -- Scan / Load / Unload sections, which each filter to their own source. id offset
    -- 6000000000+ keeps them clear of every other branch's id space.
    SELECT
      (6000000000 + ssp.id) AS id,
      ssp.barcode,
      ssp.item_name         AS "itemName",
      -- A pick is typed in pieces, but it is still worth reading in pallets. The pack size is the
      -- per-STATE one (GJ PLT / MP PLT, resolved through the slip's plant) — the same number the
      -- Sort Slip page converts with, so the two agree. No size configured means no pallet figure
      -- rather than a made-up one.
      CASE WHEN COALESCE(CASE UPPER(COALESCE(pl.state, ''))
                           WHEN 'GJ' THEN prod.gj_plt WHEN 'MP' THEN prod.mp_plt END, 0) > 0
           THEN ROUND(ssp.qty::numeric / CASE UPPER(COALESCE(pl.state, ''))
                           WHEN 'GJ' THEN prod.gj_plt WHEN 'MP' THEN prod.mp_plt END, 2)
      END::real AS pallets,
      ssp.qty               AS "totalQty",
      NULLIF(CASE UPPER(COALESCE(pl.state, ''))
               WHEN 'GJ' THEN prod.gj_plt WHEN 'MP' THEN prod.mp_plt END, 0) AS "itemsPerPallet",
      NULL::integer AS "looseQty",
      false AS "isExtra",
      false AS "isEmptyBox",
      false AS "isExchange",
      false AS "isDispatch",
      false AS "isUnload",
      false AS "isAdjust",
      'sorting' AS "sourceKind",
      NULL::text AS "purchasePlant",
      NULL::text AS "emptyBoxNote",
      -- The platform this order is being loaded on, if Loading has picked one yet — the same STV
      -- the load's own rows carry, so an order reads as one story across the sections.
      pslip.loading_stv  AS stv,
      ssp.picked_by_code AS "scannedByCode",
      ssp.picked_by_name AS "scannedByName",
      ssp.picked_at      AS "scannedAt",
      NULL::timestamp AS "adjustedAt",
      COALESCE(ssp.voided, false) AS voided,
      ssp.voided_at      AS "voidedAt",
      NULL::text AS "voidReason",
      vun.name           AS "voidedByName",
      COALESCE(ssp.sr_no, pb.new_sr) AS "srNo",
      ssp.order_number   AS "orderName",
      ss.order_date::text AS "orderDate",
      ss.plant           AS "plant",
      NULL::text         AS "sapCode"
    FROM sort_slip_picks ssp
    JOIN sort_slips ss ON ss.id = ssp.sort_slip_id
    LEFT JOIN product_by_barcode pb ON pb.bkey = LOWER(TRIM(ssp.barcode))
    LEFT JOIN plants pl ON LOWER(pl.name) = LOWER(ss.plant)
    LEFT JOIN user_name vun ON vun.user_code = ssp.voided_by_code
    -- The product row this barcode means at THIS plant — a barcode can sit on more than one row
    -- (one per plant), and they can carry different pack sizes.
    LEFT JOIN LATERAL (
      SELECT p.gj_plt, p.mp_plt FROM products p
       WHERE LOWER(TRIM(p.barcode)) = LOWER(TRIM(ssp.barcode))
       ORDER BY (LOWER(COALESCE(p.plant, '')) = LOWER(COALESCE(ss.plant, ''))) DESC, p.id
       LIMIT 1
    ) prod ON TRUE
    LEFT JOIN LATERAL (
      SELECT ps.loading_stv FROM proforma_slips ps
       WHERE ps.order_number = ssp.order_number ORDER BY ps.id DESC LIMIT 1
    ) pslip ON TRUE
  ) combined
`;

// Generic "+ Filter" column engine (client/src/lib/columnFilters.ts) mirrored server-side —
// Scan History is paginated (LIMIT/OFFSET), so unlike Stock Overview's client-side matching,
// these conditions must become real SQL to filter/paginate correctly across the whole result
// set, not just whatever page happens to be loaded. Only columns in this allowlist are ever
// touched by user input — the column id (and its SQL expression) is fixed server-side, so a
// request can never reference an arbitrary column.
const SCAN_HISTORY_FILTER_COLUMNS: Record<string, SqlFilterColumn> = {
  stv:       { sql: 'stv',         type: 'text' },
  time:      { sql: '"scannedAt"', type: 'date' },
  orderDate: { sql: '"orderDate"', type: 'date' },
  plant:     { sql: '"plant"',     type: 'text' },
  // Client's historyColumns wires the same "+ Filter" condition UI onto these three too
  // (Barcode/Qty/Pallets) — missing here meant the request still went out with the filter,
  // but the SQL filter engine silently dropped it (unknown column id, not an error),
  // so those three filters looked broken even though everything else worked.
  barcode:   { sql: 'barcode',     type: 'text' },
  qty:       { sql: '"totalQty"',  type: 'number' },
  pallets:   { sql: 'pallets',     type: 'number' },
  // Load Event tab only (the client offers it nowhere else): the proforma slip's order number.
  orderNumber: { sql: '"orderName"', type: 'text' },
};

// The names offered in the page's "Scanned by" dropdown. Three tables, scanned end to end with a
// DISTINCT — and it was re-run on every request of a page that polls itself every few seconds,
// for a list that changes when a new person scans for the first time. Held for a minute instead.
let scannerNameCache: { names: string[]; at: number } | null = null;
const SCANNER_NAME_TTL_MS = 60 * 1000;
async function scanHistoryScannerNames(): Promise<string[]> {
  if (scannerNameCache && Date.now() - scannerNameCache.at < SCANNER_NAME_TTL_MS) return scannerNameCache.names;
  const { rows } = await pool.query(
    `SELECT DISTINCT name FROM (
       SELECT scanned_by_name AS name FROM order_scan_events WHERE scanned_by_name IS NOT NULL
       UNION
       SELECT u.name FROM stock_v2_ledger sl
         JOIN users u ON u.user_code = sl.created_by_code
         WHERE u.name IS NOT NULL
       UNION
       SELECT scanned_by_name AS name FROM loading_scan_events WHERE scanned_by_name IS NOT NULL
     ) s
     ORDER BY name`,
  );
  const names = rows.map((r: any) => r.name as string);
  scannerNameCache = { names, at: Date.now() };
  return names;
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
    // One or more types, comma-separated ("extra,adjust") — the page's Type filter is a checklist,
    // and picking two means "either of these", not neither.
    //
    // A type may also name the source it belongs to: "scan:regular", "loading:extra". Without that,
    // a kind on its own means that kind from ANY source — which is what made "Scan Regular" list
    // Load Regular rows too while the section dropdown was on All Events. A bare kind still works
    // exactly as before (the section dropdown is what narrows it then).
    const KNOWN_TYPES = ['regular', 'extra', 'empty', 'exchange', 'adjust'];
    const KNOWN_SOURCES = ['scan', 'loading', 'unloading', 'stock', 'sorting'];
    const typeParams = (typeof req.query.type === 'string' ? String(req.query.type).split(',') : [])
      .map((s) => s.trim().toLowerCase())
      .map((s) => {
        const [a, b] = s.includes(':') ? s.split(':') : ['', s];
        return { source: a, kind: b };
      })
      .filter((p) => KNOWN_TYPES.includes(p.kind) && (p.source === '' || KNOWN_SOURCES.includes(p.source)));
    // Three distinct sections on the Scan History page (client dropdown) — "Scan History"
    // (receiving + exchange corrections, the original page), "Load Event" (Loading's own
    // item-scanning history, server/routes/loading.ts), and "Unload Event" (Unloading's own scan
    // history, server/routes/unloading.ts) — plus 'all', which merges all three (no source
    // condition added below at all). Default stays 'receiving' so any older/other caller that
    // never sends this param keeps seeing exactly what it always saw.
    const sourceParam  = req.query.source === 'dispatch' ? 'dispatch' : req.query.source === 'unload' ? 'unload' : req.query.source === 'sorting' ? 'sorting' : req.query.source === 'all' ? 'all' : 'receiving';
    // Scopes to one proforma order's own events — used by the Loading page's own landing table
    // (server/routes/loading.ts), whose "click a row to expand" panel re-uses this same endpoint
    // rather than a dedicated one.
    const orderParam   = typeof req.query.order   === 'string' && req.query.order.trim()    ? req.query.order.trim()   : null;
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
    if (orderParam)   { params.push(orderParam);   conditions.push(`"orderName" = $${params.length}`); }
    // Section split — see sourceParam comment above. Applied before the Type filter below so
    // 'regular'/'extra' inside the Load/Unload Event tabs only ever match their own rows, never
    // receiving ones (and vice versa), without any filter needing to know about the others.
    // 'all' adds no condition here at all — every source's rows pass through together.
    if (sourceParam !== 'all') {
      conditions.push(
        sourceParam === 'dispatch' ? `"isDispatch" = true`
        : sourceParam === 'unload' ? `"isUnload" = true`
        // Sorting is its own kind of work: its own section, and kept out of the receiving one,
        // which is otherwise "anything that is not a load or an unload".
        : sourceParam === 'sorting' ? `"sourceKind" = 'sorting'`
        : `NOT "isDispatch" AND NOT "isUnload" AND "sourceKind" <> 'sorting'`,
      );
    }
    // Empty boxes and exchanges ARE shown in scan history as their own distinct statuses, but
    // they're never product scans — so 'regular'/'extra' filters must exclude both, and the
    // box/pallet totals below exclude them too (they don't count toward order quantity). A
    // dedicated 'empty'/'exchange' filter shows only that one status.
    // Extra excludes corrections for the same reason Regular does — an edited row reads as Adjust.
    const TYPE_CONDITION: Record<string, string> = {
      regular:  `("isExtra" = false AND barcode <> 'EMPTY_BOX' AND NOT "isExchange" AND NOT "isAdjust")`,
      extra:    `("isExtra" = true AND barcode <> 'EMPTY_BOX' AND NOT "isAdjust")`,
      empty:    `(barcode = 'EMPTY_BOX')`,
      exchange: `("isExchange" = true)`,
      adjust:   `("isAdjust" = true)`,
    };
    // Several types selected → a row matching ANY of them passes. A type that names its source
    // must match both, so "scan:regular" can never pull in a loading row.
    if (typeParams.length > 0) {
      const clauses = typeParams.map(({ source, kind }) =>
        source ? `("sourceKind" = '${source}' AND ${TYPE_CONDITION[kind]})` : TYPE_CONDITION[kind]);
      conditions.push(`(${clauses.join(' OR ')})`);
    }
    if (searchParam) {
      params.push(`%${searchParam.toLowerCase()}%`);
      const n = params.length;
      conditions.push(`(LOWER(COALESCE("itemName",'')) LIKE $${n} OR LOWER(COALESCE(barcode,'')) LIKE $${n} OR LOWER(COALESCE("scannedByName",'')) LIKE $${n})`);
    }
    applyColumnFiltersToSql(filtersParam, SCAN_HISTORY_FILTER_COLUMNS, conditions, params);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const baseFrom = `FROM ${SCAN_HISTORY_COMBINED_SOURCE} ${where}`;

    // Every number in one pass over the matching rows. This used to be three separate queries
    // (count, summary tiles, table totals) with the same WHERE, so the whole union was built and
    // scanned FOUR times per request — the page's own poll then did that every few seconds. The
    // tiles ignore stock corrections and the table totals ignore voided rows, which is what the
    // FILTERs below say, so one scan answers all of it.
    //
    // Destructuring order must track the array below: data, aggregates, scanners.
    const [dataRes, aggRes, scanners] = await Promise.all([
      pool.query(
        `SELECT *
         ${baseFrom}
         ORDER BY "scannedAt" DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      pool.query(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM("totalQty") FILTER (WHERE barcode <> 'EMPTY_BOX' AND "sourceKind" NOT IN ('stock', 'sorting')), 0)  AS "totalBoxes",
           -- Fractional (qty ÷ itemsPerPallet), not the row's own floor()'d "pallets" column —
           -- that column means "whole physical pallets in THIS ONE scan" (a real, separate fact
           -- used for the pallets/loose breakdown elsewhere), which is legitimately 0 for a scan
           -- smaller than one pallet even though it's still, say, 0.07 of a pallet. Summing the
           -- floored figure made a handful of small scans silently disappear from this total —
           -- matches the fractional convention every other pallet total in the app already uses
           -- (Scan Operations' own Expected/Received/Remaining tiles, Sort Slip, etc.).
           COALESCE(SUM(CASE WHEN "itemsPerPallet" > 0 THEN "totalQty"::numeric / "itemsPerPallet" ELSE 0 END)
             FILTER (WHERE barcode <> 'EMPTY_BOX' AND "sourceKind" NOT IN ('stock', 'sorting')), 0)  AS "totalPallets",
           COUNT(*) FILTER (WHERE "isExtra" = true AND barcode <> 'EMPTY_BOX' AND "sourceKind" NOT IN ('stock', 'sorting')) AS "extraCount",
           COALESCE(SUM("totalQty") FILTER (WHERE barcode = 'EMPTY_BOX' AND "sourceKind" NOT IN ('stock', 'sorting')), 0)   AS "emptyBoxCount",
           -- Stock corrections (a delete, a void or a manual Adjust writes a signed ledger row)
           -- are listed, but they are not scanning, and a negative one used to pull this total
           -- below what was actually scanned — a day with one big correction could even read as
           -- a minus. Counted the same way the tiles above already count: scans only.
           COALESCE(SUM("totalQty") FILTER (WHERE NOT COALESCE(voided, false) AND "sourceKind" NOT IN ('stock', 'sorting')), 0) AS "qtyTotal",
           COALESCE(SUM(CASE WHEN "itemsPerPallet" > 0 THEN "totalQty"::numeric / "itemsPerPallet" ELSE 0 END)
             FILTER (WHERE NOT COALESCE(voided, false) AND "sourceKind" NOT IN ('stock', 'sorting')), 0) AS "palletsTotal"
         ${baseFrom}`,
        params,
      ),
      scanHistoryScannerNames(),
    ]);

    // Party name for the rows that belong to a proforma order (Loading, Sort Slip picks) — looked
    // up for just this page's order numbers rather than joined into every UNION branch above.
    // Other sources have no party, so theirs stays null.
    const slipOrderNumbers = Array.from(new Set(
      dataRes.rows
        .filter((r: any) => (r.sourceKind === 'loading' || r.sourceKind === 'sorting') && r.orderName)
        .map((r: any) => String(r.orderName)),
    ));
    const partyByOrder = new Map<string, string>();
    if (slipOrderNumbers.length > 0) {
      const partyRes = await pool.query(
        `SELECT order_number, MIN(party_name) AS party_name FROM proforma_slips
         WHERE order_number = ANY($1::text[]) GROUP BY order_number`,
        [slipOrderNumbers],
      );
      for (const r of partyRes.rows) partyByOrder.set(r.order_number, r.party_name);
    }
    const itemsWithParty = dataRes.rows.map((r: any) => ({ ...r, partyName: partyByOrder.get(String(r.orderName)) ?? null }));

    return res.json({
      items:        itemsWithParty,
      total:        parseInt(aggRes.rows[0].total, 10),
      totalBoxes:   parseInt(aggRes.rows[0].totalBoxes, 10),
      totalPallets: parseFloat(aggRes.rows[0].totalPallets),
      extraCount:   parseInt(aggRes.rows[0].extraCount, 10),
      emptyBoxCount: parseInt(aggRes.rows[0].emptyBoxCount, 10),
      scanners,
      qtyTotal:     parseInt(aggRes.rows[0].qtyTotal, 10),
      palletsTotal: parseFloat(aggRes.rows[0].palletsTotal),
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error generating scan history:', error);
    return res.status(500).json({ error: 'Failed to generate scan history' });
  }
});

// ── POST /reports/scan-history/remove ────────────────────────────────────────────────────────
// Takes one row out of the Scan History list. Deliberately narrow - only a scan that is already VOIDED (receiving, loading or unloading) can go.
// It counts towards nothing any more, so the line is just noise once it has been dealt with. A live scan and a Stock Adjust / Exchange (somebody's
// deliberate correction, kept on the book) are refused.
//
// "Remove" hides the row; the underlying record stays - a voided scan is the proof the void happened. Activities records who removed what.

router.post('/reports/scan-history/remove', async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const role = String(user?.role ?? '').toLowerCase();
    const isAdmin = role === 'admin' || role === 'super-admin';
    let writable: string[] = [];
    try { writable = JSON.parse(user?.pageWriteAccess || '[]'); } catch { /* default [] */ }
    if (!isAdmin && !writable.includes('scan-history')) {
      return res.status(403).json({ message: 'Write access to Scan History is required to remove an entry.' });
    }

    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'A row id is required' });

    // Same id offsets the combined source builds its ids with (see SCAN_HISTORY_COMBINED_SOURCE). Stock Overview rows (5e9+) are never removable.
    if (id >= 5_000_000_000) return res.status(409).json({ message: 'A Stock Adjust entry is a correction on the book and cannot be removed from history. An admin can delete it on the Stock page.' });
    const target =
      id >= 4_000_000_000 ? { table: 'unload_scan_events', rowId: id - 4_000_000_000 }
      : id >= 3_000_000_000 ? { table: 'loading_scan_events', rowId: id - 3_000_000_000 }
      : { table: 'order_scan_events', rowId: id };

    // The eligibility rule lives HERE, not only in the button that offers it: a scan must be voided.
    const where = `id = $1 AND COALESCE(voided, false) = true`;
    // order_scan_events has no plant column of its own (unlike loading_scan_events,
    // unload_scan_events and stock_movements, which all do) — RETURNING it unconditionally used
    // to throw "column \"plant\" does not exist" for every Order Scan void removal, the most
    // common case, which is why this always came back as a 500.
    const hasPlantColumn = target.table !== 'order_scan_events';
    const { rows } = await pool.query(
      `UPDATE ${target.table} SET hidden_in_history = true
       WHERE ${where} AND NOT COALESCE(hidden_in_history, false)
       RETURNING barcode${hasPlantColumn ? ', plant' : ''}`,
      [target.rowId],
    );
    if (rows.length === 0) {
      return res.status(409).json({
        message: 'Only a voided scan can be removed from history — void it first.',
      });
    }

    // Written straight to the table — this router has no storage import, and an activity row is
    // the whole point of "removed here, still on record there".
    await pool.query(
      `INSERT INTO activities (page_name, action, entity_type, entity_id, details, user_code, user_name, created_at)
       VALUES ('Scan History','delete','scan_history_entry',$1,$2,$3,$4,NOW())`,
      [
        String(id),
        `Removed a voided scan entry from Scan History`
          + ` (${target.table} #${target.rowId}, ${rows[0].barcode ?? 'no barcode'}${rows[0].plant ? `, ${rows[0].plant}` : ''})`,
        user?.userCode ?? null,
        user?.name || user?.username || user?.userCode || null,
      ],
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Error removing a scan-history entry:', error);
    return res.status(500).json({ message: 'Failed to remove the entry' });
  }
});

// ── GET /reports/scan-history/filter-values ──────────────────────────────────────────────────
// Every distinct value for every generic "+ Filter" column, in one response — Scan History is
// paginated (only one page of rows ever reaches the browser), so unlike Stock Overview's Values
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
    // Same tab scoping as GET /reports/scan-history — Values checklists on the Load/Unload Event
    // tabs shouldn't offer barcodes/plants/etc. that only ever appear on other rows, and vice
    // versa. 'all' merges every source, so no source condition at all.
    const sourceParam = req.query.source === 'dispatch' ? 'dispatch' : req.query.source === 'unload' ? 'unload' : req.query.source === 'sorting' ? 'sorting' : req.query.source === 'all' ? 'all' : 'receiving';
    const sourceCond =
      sourceParam === 'dispatch' ? `"isDispatch" = true`
      : sourceParam === 'unload' ? `"isUnload" = true`
      : sourceParam === 'sorting' ? `"sourceKind" = 'sorting'`
      : sourceParam === 'all' ? null
      : `NOT "isDispatch" AND NOT "isUnload"`;
    // Always starts with WHERE (falling back to the no-op "WHERE TRUE") — every call site below
    // unconditionally appends "AND ..." after this, which is a syntax error if this were ever ''
    // (an admin with source=all and no plant restriction has nothing else to put here).
    const plantWhere = allowedPlants !== null
      ? (sourceCond ? `WHERE LOWER("plant") = ANY($1::text[]) AND ${sourceCond}` : `WHERE LOWER("plant") = ANY($1::text[])`)
      : (sourceCond ? `WHERE ${sourceCond}` : 'WHERE TRUE');
    const plantParams = allowedPlants !== null ? [allowedPlants] : [];

    const entries = Object.entries(SCAN_HISTORY_FILTER_COLUMNS);
    const results = await Promise.all(entries.map(async ([id, col]) => {
      if (col.type === 'date') {
        const { rows } = await pool.query(
          `SELECT DISTINCT DATE(${col.sql})::text AS d
           FROM ${SCAN_HISTORY_COMBINED_SOURCE} ${plantWhere} AND ${col.sql} IS NOT NULL
           ORDER BY d DESC LIMIT 500`,
          plantParams,
        );
        return [id, rows.map((r: any) => ({ value: r.d, label: format(new Date(r.d), 'MMM d, yyyy') }))] as const;
      }
      // SELECT DISTINCT requires ORDER BY to use the exact same expression as the select list —
      // ordering by the raw (uncast) column while selecting its ::text cast is two different
      // expressions to Postgres and errors (42P10). Number columns sort correctly on their own
      // numeric value without casting; text/enum columns need the cast for the emptiness check.
      const valueExpr = col.type === 'number' ? col.sql : `${col.sql}::text`;
      const { rows } = await pool.query(
        `SELECT DISTINCT ${valueExpr} AS v
         FROM ${SCAN_HISTORY_COMBINED_SOURCE} ${plantWhere} AND ${col.sql} IS NOT NULL${col.type === 'number' ? '' : ` AND ${col.sql}::text <> ''`}
         ORDER BY v LIMIT 500`,
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

// ── POST /api/scan-sessions/reports/exchange-stock ───────────────────────────────────────────
// Manual stock swap between two products at ONE plant — "this physical stock was actually
// product B, not product A". Admin, or anyone granted Write Access to the "overall-stock" page.
// Two Stock Overview ledger entries of kind 'exchange' are written (− on fromBarcode, + on toBarcode). Never touches order_scan_events, so
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
      client.query(`SELECT id, name FROM products WHERE LOWER(barcode) = LOWER($1) LIMIT 1`, [fromBarcode]),
      client.query(`SELECT id, name FROM products WHERE LOWER(barcode) = LOWER($1) LIMIT 1`, [toBarcode]),
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
    const fromProductId = fromProduct.rows[0].id as number;
    const toProductId = toProduct.rows[0].id as number;

    // Stock Overview: the source product's line at this plant must hold the boxes being swapped out.
    const fromLine = await findLineForProduct(client, plant, fromBarcode, fromProductId, false);
    const currentStock = fromLine ? await lockLineStock(client, fromLine.id) : 0;
    if (currentStock < removeQty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Only ${currentStock} of "${fromName}" in stock at ${plant} — can't remove ${removeQty}.` });
    }

    // Audit ledger — two rows, each stands on its own (no linking column needed). This is also
    // the exact source Scan History's "Exchange" filter reads from.
    const fromReason = `Exchanged ${removeQty} for ${addQty} × ${toName} (${toBarcode})${userNote ? ` — ${userNote}` : ''}`;
    const toReason = `Exchanged ${addQty} from ${removeQty} × ${fromName} (${fromBarcode})${userNote ? ` — ${userNote}` : ''}`;
    await v2Adjust(client, { plant, barcode: fromBarcode, productId: fromProductId, qty: -removeQty, kind: 'exchange', reason: fromReason, userCode });
    await v2Adjust(client, { plant, barcode: toBarcode, productId: toProductId, qty: addQty, kind: 'exchange', reason: toReason, userCode });

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
// Arrival history for ONE item at ONE plant — powers the "click a row in Stock Overview" drill
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
    const productIdRaw = parseInt(String(req.query.productId ?? ''), 10);
    // Two products can share a barcode (65 g / 60 g): the history of a stock line is that PRODUCT's entries only.
    const productId = Number.isFinite(productIdRaw) ? productIdRaw : null;

    // Same plant scoping as every other report here: admins see any plant, everyone else is
    // limited to their assigned plant(s).
    const allowed = getUserPlants(req.user);
    if (allowed !== null && !allowed.includes(plant.toLowerCase())) {
      return res.status(403).json({ message: 'Access denied for this plant' });
    }

    // Order Scan's own receiving scans for this item at this plant (the Scan Order tab): every live entry of every CSV, newest first. A credit
    // row only re-assigns boxes that an earlier Extra already brought in, so it is left out.
    const { rows } = await pool.query(`
      SELECT
        e.id, e.total_qty AS qty, CASE WHEN e.is_extra THEN e.total_qty ELSE 0 END AS "extraQty", 'receive' AS type, NULL::text AS reason,
        e.scanned_at AS "arrivedAt",
        ois.csv_file_name AS "orderName", ois.order_date AS "orderDate", ois.part_index AS "partIndex"
      FROM order_scan_events e
      JOIN order_import_sessions ois ON ois.id = e.session_id
      WHERE LOWER(TRIM(e.barcode)) = LOWER(TRIM($1)) AND LOWER(ois.plant) = LOWER($2)
        AND e.voided IS NOT TRUE AND e.is_credit IS NOT TRUE AND NOT COALESCE(e.hidden_in_history, false)
        AND ($3::int IS NULL OR e.product_id = $3::int OR (e.product_id IS NULL AND (SELECT COUNT(*) FROM products pp WHERE LOWER(TRIM(pp.barcode)) = LOWER(TRIM($1))) <= 1))
      ORDER BY e.scanned_at DESC
      LIMIT 500
    `, [barcode, plant, productId]);

    res.json({ items: rows });
  } catch (error) {
    console.error('Error fetching stock movement history:', error);
    res.status(500).json({ error: 'Failed to fetch stock movement history' });
  }
});

// ── GET /api/scan-sessions/reports/unloading-history?barcode=X&plant=Y ──────────────────────
// Unloading's own arrival history for ONE item at ONE plant — deliberately separate from
// /reports/stock-movements above rather than folded into it: that query's session_id join only
// ever resolves against order_import_sessions, so an Unloading-sourced row there shows up with
// no order/vehicle/date at all (session_id doesn't record which sessions table it points to —
// see stock_movements' own comment). Going straight to unload_scan_events (which already carries
// plant and vehicleNumber directly, no ambiguous join needed) sidesteps that entirely, so Overall
// Stock's History view shows Scanning and Unloading as two clean, separately-sourced lists
// instead of trying to make one query understand both.
router.get('/reports/unloading-history', async (req: Request, res: Response) => {
  try {
    const barcode = typeof req.query.barcode === 'string' ? req.query.barcode.trim() : '';
    const plant = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
    if (!barcode || !plant) {
      return res.status(400).json({ message: 'barcode and plant are required' });
    }
    const productIdRaw = parseInt(String(req.query.productId ?? ''), 10);
    // Two products can share a barcode (65 g / 60 g): the history of a stock line is that PRODUCT's entries only.
    const productId = Number.isFinite(productIdRaw) ? productIdRaw : null;

    const allowed = getUserPlants(req.user);
    if (allowed !== null && !allowed.includes(plant.toLowerCase())) {
      return res.status(403).json({ message: 'Access denied for this plant' });
    }

    const { rows } = await pool.query(`
      SELECT
        e.id, e.total_qty AS qty, e.pallets, e.loose_qty AS "looseQty", e.is_extra AS "isExtra", COALESCE(e.is_adjust, false) AS "isAdjust",
        e.voided, e.void_reason AS "voidReason", e.scanned_at AS "scannedAt",
        e.scanned_by_name AS "scannedByName", e.stv,
        e.vehicle_number AS "vehicleNumber", s.order_date AS "orderDate", s.part_index AS "partIndex"
      FROM unload_scan_events e
      LEFT JOIN unload_import_sessions s ON s.id = e.session_id
      WHERE LOWER(e.barcode) = LOWER($1) AND LOWER(e.plant) = LOWER($2)
        AND ($3::int IS NULL OR e.product_id = $3::int OR (e.product_id IS NULL AND (SELECT COUNT(*) FROM products pp WHERE LOWER(TRIM(pp.barcode)) = LOWER(TRIM($1))) <= 1))
      ORDER BY e.scanned_at DESC
      LIMIT 500
    `, [barcode, plant, productId]);

    res.json({ items: rows });
  } catch (error) {
    console.error('Error fetching unloading history:', error);
    res.status(500).json({ error: 'Failed to fetch unloading history' });
  }
});

// ── GET /api/scan-sessions/reports/loading-history?barcode=X&plant=Y ────────────────────────
// Loading's own dispatch history for ONE item at ONE plant — same separate-by-source spirit as
// unloading-history above: loading_scan_events already carries plant directly, joined to
// proforma_slips only for the order's own date (loading_scan_events has no date column of its
// own). A third clean list alongside Scanning and Unloading, not merged into either.
router.get('/reports/loading-history', async (req: Request, res: Response) => {
  try {
    const barcode = typeof req.query.barcode === 'string' ? req.query.barcode.trim() : '';
    const plant = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
    if (!barcode || !plant) {
      return res.status(400).json({ message: 'barcode and plant are required' });
    }
    const productIdRaw = parseInt(String(req.query.productId ?? ''), 10);
    // Two products can share a barcode (65 g / 60 g): the history of a stock line is that PRODUCT's entries only.
    const productId = Number.isFinite(productIdRaw) ? productIdRaw : null;

    const allowed = getUserPlants(req.user);
    if (allowed !== null && !allowed.includes(plant.toLowerCase())) {
      return res.status(403).json({ message: 'Access denied for this plant' });
    }

    const { rows } = await pool.query(`
      SELECT
        e.id, e.total_qty AS qty, e.pallets, e.loose_qty AS "looseQty", e.is_extra AS "isExtra",
        e.voided, e.void_reason AS "voidReason", e.scanned_at AS "scannedAt",
        e.scanned_by_name AS "scannedByName", COALESCE(e.is_adjust, false) AS "isAdjust",
        e.order_number AS "orderNumber", ps.order_date AS "orderDate"
      FROM loading_scan_events e
      LEFT JOIN proforma_slips ps ON ps.order_number = e.order_number
      WHERE LOWER(e.barcode) = LOWER($1) AND LOWER(e.plant) = LOWER($2)
        AND ($3::int IS NULL OR e.product_id = $3::int OR (e.product_id IS NULL AND (SELECT COUNT(*) FROM products pp WHERE LOWER(TRIM(pp.barcode)) = LOWER(TRIM($1))) <= 1))
      ORDER BY e.scanned_at DESC
      LIMIT 500
    `, [barcode, plant, productId]);

    res.json({ items: rows });
  } catch (error) {
    console.error('Error fetching loading history:', error);
    res.status(500).json({ error: 'Failed to fetch loading history' });
  }
});

// ── GET /api/scan-sessions/reports/adjust-history?barcode=X&plant=Y ─────────────────────────
// Only adjustments for ONE item at ONE plant — Stock Overview's History > Adjust tab. Two kinds:
//   manual  — a person's Adjust from Stock Overview (stock_movements, source 'manual')
//   loading — the Loading Items table's +/- (loading_scan_events.is_adjust)
// stockQty is always the change to stock (+ added / − removed): a loading +5 took 5 more out of
// stock, so its stockQty is −5; loadedQty keeps the loading side's own sign.
router.get('/reports/adjust-history', async (req: Request, res: Response) => {
  try {
    const barcode = typeof req.query.barcode === 'string' ? req.query.barcode.trim() : '';
    const plant = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
    if (!barcode || !plant) {
      return res.status(400).json({ message: 'barcode and plant are required' });
    }
    const productIdRaw = parseInt(String(req.query.productId ?? ''), 10);
    // Two products can share a barcode (65 g / 60 g): the history of a stock line is that PRODUCT's entries only.
    const productId = Number.isFinite(productIdRaw) ? productIdRaw : null;

    const allowed = getUserPlants(req.user);
    if (allowed !== null && !allowed.includes(plant.toLowerCase())) {
      return res.status(403).json({ message: 'Access denied for this plant' });
    }

    const { rows } = await pool.query(`
      SELECT * FROM (
        -- Stock Overview corrections for the item's line(s) at this plant: a manual Adjust, an Opening entry or a Clear read as 'manual'; an Exchange
        -- as 'correction' (the page words it as an exchange from its reason).
        SELECT
          CASE WHEN sl.kind = 'exchange' THEN 'correction' ELSE 'manual' END AS kind, sl.id, sl.qty AS "stockQty", NULL::integer AS "loadedQty",
          sl.reason, NULL::text AS "orderNumber", NULL::text AS "orderDate",
          sl.created_at AS "at",
          (SELECT u.name FROM users u WHERE u.user_code = sl.created_by_code LIMIT 1) AS "byName",
          false AS voided
        FROM stock_v2_ledger sl
        JOIN stock_v2_lines ln ON ln.id = sl.line_id
        WHERE LOWER(TRIM(ln.barcode)) = LOWER(TRIM($1)) AND LOWER(TRIM(ln.plant)) = LOWER(TRIM($2))
          AND ($3::int IS NULL OR ln.product_id = $3::int OR (ln.product_id IS NULL AND (SELECT COUNT(*) FROM products pp WHERE LOWER(TRIM(pp.barcode)) = LOWER(TRIM($1))) <= 1))

        UNION ALL

        SELECT
          'loading' AS kind, e.id, -e.total_qty AS "stockQty", e.total_qty AS "loadedQty",
          NULL::text AS reason, e.order_number AS "orderNumber",
          (SELECT ps.order_date::text FROM proforma_slips ps WHERE ps.order_number = e.order_number LIMIT 1) AS "orderDate",
          e.scanned_at AS "at", e.scanned_by_name AS "byName", COALESCE(e.voided, false) AS voided
        FROM loading_scan_events e
        WHERE e.is_adjust = true
          AND LOWER(TRIM(e.barcode)) = LOWER(TRIM($1)) AND LOWER(TRIM(e.plant)) = LOWER(TRIM($2))
          AND ($3::int IS NULL OR e.product_id = $3::int OR (e.product_id IS NULL AND (SELECT COUNT(*) FROM products pp WHERE LOWER(TRIM(pp.barcode)) = LOWER(TRIM($1))) <= 1))
      ) adjustments
      ORDER BY "at" DESC
      LIMIT 500
    `, [barcode, plant, productId]);

    res.json({ items: rows });
  } catch (error) {
    console.error('Error fetching adjust history:', error);
    res.status(500).json({ error: 'Failed to fetch adjust history' });
  }
});

export default router;
