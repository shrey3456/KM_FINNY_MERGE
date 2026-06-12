import { Router, Request, Response, NextFunction } from 'express';
import { db, pool } from '../db';
import {
  orderImportSessions, orderImportItems, orderScanItems, orderScanEvents,
  products, users, plants, plantStvs,
} from '../../shared/schema';
import { eq, and, ne, desc, asc, gte, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

// Case-insensitive plant match: LOWER(plant) = LOWER(filter)
function plantEq(filter: string) {
  return sql`LOWER(${orderImportSessions.plant}) = LOWER(${filter})`;
}

const router = Router();

// ── Auth helpers ──────────────────────────────────────────────────────────────

function requireScanRole(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  next(); // any logged-in user may access scan routes; plant filtering handles the rest
}

function requireImportRole(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const role = ((req.user as any)?.role ?? '').toLowerCase();
  if (!['admin', 'super-admin', 'billing'].includes(role))
    return res.status(403).json({ message: 'Only admin/billing can manage sessions' });
  next();
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

function getPlantFilter(user: any): string | null {
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

// Pick correct pallet size based on plant
function getPalletSize(product: any, plant: string): number {
  const p = (plant ?? '').toUpperCase();
  if (p.includes('VAL')) return Number(product.valPlt) || Number(product.itemsPerPallet) || 0;
  if (p.includes('IND')) return Number(product.indPlt) || Number(product.itemsPerPallet) || 0;
  return Number(product.itemsPerPallet) || 0;
}

router.use('/order-scan', requireScanRole);

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

    const conditions: any[] = [eq(orderImportSessions.scanStatus, 'active')];
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
// Returns today's import sessions with scan status + importer/activator names.
// Dispatch users see only their plant.
router.get('/order-scan/sessions', async (req: Request, res: Response) => {
  try {
    const plantFilter = getPlantFilter(req.user);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const importedBy  = alias(users, 'imported_by');
    const activatedBy = alias(users, 'activated_by');

    let q = db
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
      })
      .from(orderImportSessions)
      .leftJoin(importedBy,  eq(orderImportSessions.importedByCode,      importedBy.userCode))
      .leftJoin(activatedBy, eq(orderImportSessions.scanActivatedByCode, activatedBy.userCode))
      .where(
        and(
          gte(orderImportSessions.createdAt, today),
          lte(orderImportSessions.createdAt, tomorrow),
          ...(plantFilter
            ? [plantEq(plantFilter)]
            : []),
        ),
      )
      .orderBy(desc(orderImportSessions.createdAt));

    const sessions = await q;
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch sessions' });
  }
});

// ── POST /api/order-scan/sessions/:id/activate ───────────────────────────────
// Activates a session for scanning. Pre-populates orderScanItems from import items.
// Only one active session per plant at a time.
router.post('/order-scan/sessions/:id/activate', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

  try {
    const [session] = await db.select().from(orderImportSessions).where(eq(orderImportSessions.id, id));
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (session.scanStatus === 'completed') return res.status(409).json({ message: 'Session already completed' });

    // Check for another active session on the same plant
    const plantFilter = getPlantFilter(req.user);
    const conflictCheck = plantFilter
      ? plantEq(plantFilter)
      : sql`LOWER(${orderImportSessions.plant}) = LOWER(${session.plant})`;

    const [conflict] = await db
      .select({ id: orderImportSessions.id, csvFileName: orderImportSessions.csvFileName })
      .from(orderImportSessions)
      .where(and(
        conflictCheck,
        eq(orderImportSessions.scanStatus, 'active'),
        ne(orderImportSessions.id, id),
      ));

    if (conflict) {
      return res.status(409).json({
        message: `Another session is already active for ${session.plant}`,
        conflictSessionId: conflict.id,
        conflictFileName: conflict.csvFileName,
      });
    }

    const userCode = (req.user as any)?.userCode ?? null;

    // Mark session active
    await db.update(orderImportSessions)
      .set({ scanStatus: 'active', scanActivatedByCode: userCode, scanActivatedAt: new Date() })
      .where(eq(orderImportSessions.id, id));

    // Pre-populate orderScanItems if not already done
    const existingItems = await db.select({ id: orderScanItems.id })
      .from(orderScanItems).where(eq(orderScanItems.sessionId, id));

    if (existingItems.length === 0) {
      const importItems = await db.select().from(orderImportItems)
        .where(eq(orderImportItems.sessionId, id));

      if (importItems.length > 0) {
        // Batch-fetch products for pallet size lookup
        const barcodes = importItems.map((i) => i.barcode).filter(Boolean) as string[];
        const productRows = barcodes.length
          ? await db.select({
              barcode: products.barcode,
              itemsPerPallet: products.itemsPerPallet,
              valPlt: products.valPlt,
              indPlt: products.indPlt,
            }).from(products)
          : [];

        const productMap = new Map(productRows.map((p) => [p.barcode, p]));

        await db.insert(orderScanItems).values(
          importItems.map((item) => {
            const prod = item.barcode ? productMap.get(item.barcode) : null;
            const palletSize = prod ? getPalletSize(prod, session.plant) : 0;
            return {
              sessionId: id,
              orderImportItemId: item.id,
              barcode: item.barcode,
              itemName: item.itemName,
              sapCode: item.sapCode,
              expectedQty: item.quantity ?? 0,
              itemsPerPallet: palletSize,
            };
          }),
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Activation failed' });
  }
});

// ── POST /api/order-scan/sessions/:id/deactivate ─────────────────────────────
// Releases the active lock without completing — allows another session to go active.
router.post('/order-scan/sessions/:id/deactivate', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    await db.update(orderImportSessions)
      .set({ scanStatus: 'available' })
      .where(eq(orderImportSessions.id, id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Deactivation failed' });
  }
});

// ── POST /api/order-scan/sessions/:id/complete ───────────────────────────────
router.post('/order-scan/sessions/:id/complete', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    await db.update(orderImportSessions)
      .set({ scanStatus: 'completed', scanCompletedAt: new Date() })
      .where(eq(orderImportSessions.id, id));
    res.json({ success: true });
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
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch items' });
  }
});

// ── POST /api/order-scan/sessions/:id/scan ───────────────────────────────────
// Records a scan event. Updates the matching orderScanItem totals atomically.
// Body: { barcode, pallets, looseQty, isExtra }
router.post('/order-scan/sessions/:id/scan', async (req: Request, res: Response) => {
  const sessionId = parseInt(req.params.id);
  if (isNaN(sessionId)) return res.status(400).json({ message: 'Invalid session ID' });

  try {
    const { barcode, pallets = 1, looseQty = 0, isExtra = false, stv = null } = req.body as {
      barcode: string; pallets: number; looseQty: number; isExtra: boolean; stv?: string | null;
    };

    if (!barcode) return res.status(400).json({ message: 'barcode is required' });

    const [session] = await db.select().from(orderImportSessions)
      .where(eq(orderImportSessions.id, sessionId));
    if (!session) return res.status(404).json({ message: 'Session not found' });

    // Find matching scan item
    const [scanItem] = await db.select().from(orderScanItems)
      .where(and(
        eq(orderScanItems.sessionId, sessionId),
        eq(orderScanItems.barcode, barcode),
      ));

    const itemsPerPallet = scanItem?.itemsPerPallet ?? 0;
    const totalQty = Math.round(pallets * Math.max(1, itemsPerPallet)) + looseQty;

    const userCode = (req.user as any)?.userCode ?? null;
    const userName  = (req.user as any)?.name ?? null;

    // Insert scan event
    const [event] = await db.insert(orderScanEvents).values({
      sessionId,
      scanItemId: scanItem?.id ?? null,
      barcode,
      itemName: scanItem?.itemName ?? null,
      pallets,
      looseQty,
      totalQty,
      itemsPerPallet,
      isExtra: isExtra || !scanItem,
      stv: stv ?? null,
      scannedByCode: userCode,
      scannedByName: userName,
    }).returning();

    // Update scan item totals atomically (avoid race conditions)
    let updatedItem = null;
    if (scanItem) {
      await pool.query(
        `UPDATE order_scan_items
         SET scanned_pallets    = COALESCE(scanned_pallets, 0)    + $1,
             scanned_loose_qty  = COALESCE(scanned_loose_qty, 0)  + $2,
             total_scanned_qty  = COALESCE(total_scanned_qty, 0)  + $3,
             status             = CASE
               WHEN COALESCE(total_scanned_qty, 0) + $3 >= expected_qty THEN 'complete'
               WHEN COALESCE(total_scanned_qty, 0) + $3 > 0             THEN 'partial'
               ELSE 'pending'
             END,
             last_scanned_at    = NOW()
         WHERE id = $4`,
        [pallets, looseQty, totalQty, scanItem.id],
      );

      const result = await pool.query('SELECT * FROM order_scan_items WHERE id = $1', [scanItem.id]);
      updatedItem = result.rows[0];
    }

    res.status(201).json({ event, updatedItem });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Scan failed' });
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

export default router;
