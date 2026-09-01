import { Router, Request, Response, NextFunction } from 'express';
import { storage } from '../storage';
import { pool } from '../db';
import { requirePageAccess, requirePageWrite, WRITE_ADMIN_ROLES } from '../lib/pageAccess';
import { getPlantStateCode, getPalletSize, resolvePalletSizeOrQty } from './order-scan';

// Loading — two things happen here:
//   1. Link a vehicle (from Vehicle Master) onto a Proforma Slip: sets the slip's vehicleNumber,
//      copies the vehicle's volume onto the slip's totalVolume, and (read-time only, never
//      stored) resolves the vehicle's RTO number through that same link.
//   2. Scan the slip's own items onto that vehicle — same barcode-matching, pallet/loose entry,
//      and "extra beyond expected" rules as Order Scan (see loading_scan_events in
//      shared/schema.ts), and each confirmed scan actually decrements product_plant_stock —
//      a real, scan-verified removal, not a passive estimate from the slip's planned quantity.
// Entirely new endpoints/file for a new page — no reuse of the old Load Operations feature/API.
// Reuses Order Scan's pallet-size resolution helpers directly (getPlantStateCode/getPalletSize/
// resolvePalletSizeOrQty) so both pages agree on "what counts as one pallet" — that's shared
// domain logic, not the legacy feature this page was told not to depend on.
const router = Router();

function actor(req: Request): { userCode?: string; userName?: string } {
  const u = req.user as any;
  return { userCode: u?.userCode, userName: u?.name || u?.username || u?.userCode };
}

function isAdmin(req: Request): boolean {
  const role = ((req.user as any)?.role ?? '').toString().toLowerCase();
  return WRITE_ADMIN_ROLES.includes(role);
}

const normalize = (value?: string | number | null) => String(value ?? '').trim().toLowerCase();

// Mirrors Order Scan's canCompletePart exactly (server/routes/order-scan.ts) — anyone can
// complete a load EXCEPT designations "Loader"/"Helper"/"Driver"/"Scanner"; admin/super-admin
// always allowed. This is the "force complete even if not everything is loaded" button.
function canCompleteLoad(user: any): boolean {
  const role = (user?.role ?? '').toLowerCase().trim();
  if (['admin', 'super-admin'].includes(role)) return true;
  const designation = (user?.designation ?? '').toLowerCase().trim();
  return !['loader', 'helper', 'driver', 'scanner'].includes(designation);
}

function requireCompleteLoadAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  if (!canCompleteLoad(req.user)) return res.status(403).json({ message: 'You do not have permission to complete this load.' });
  next();
}

// Mirrors order-scan.ts's local hasWriteAccess/requireVoidAccess exactly, swapping "scan-order"
// for "loading": admin, or anyone with Write Access to BOTH "loading" and "scan-history" (the
// page this void action is actually triggered from — see the Load Event tab in Scan History).
function hasWriteAccess(user: any, pageKey: string): boolean {
  const role = (user?.role ?? '').toString().toLowerCase();
  if (WRITE_ADMIN_ROLES.includes(role)) return true;
  let writable: string[] = [];
  try { writable = JSON.parse(user?.pageWriteAccess || '[]'); } catch { /* default [] */ }
  return writable.includes(pageKey);
}

function requireLoadingVoidAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const user = req.user as any;
  if (isAdmin(req)) return next();
  if (hasWriteAccess(user, 'loading') && hasWriteAccess(user, 'scan-history')) return next();
  return res.status(403).json({ message: 'Write access required' });
}

// Attaches the linked vehicle's RTO number to a slip response, resolved live through
// vehicleNumber — never stored on proforma_slips itself (see file header comment).
async function withRto(slip: any) {
  if (!slip?.vehicleNumber) return { ...slip, rtoNumber: null };
  const vehicle = await storage.getVehicleInfoByVehicleNumber(slip.vehicleNumber);
  return { ...slip, rtoNumber: vehicle?.rtoNumber ?? null };
}

// Attaches load progress to each proforma item (expected/loaded/remaining/itemsPerPallet,
// current stock at this plant) and reports whether the whole order is fully loaded — the same
// shape both the GET (page load) and POST /scan (after each scan) responses return, so the
// client always has one consistent source of truth for "what's left to load".
async function withProgress(slip: any, items: any[]) {
  const state = await getPlantStateCode(pool, slip.plant ?? '');

  const { rows: loadedRows } = await pool.query(
    `SELECT barcode, COALESCE(SUM(total_qty), 0)::int AS "loadedQty"
     FROM loading_scan_events WHERE order_number = $1 AND voided IS NOT TRUE GROUP BY barcode`,
    [slip.orderNumber],
  );
  const loadedByBarcode = new Map<string, number>(loadedRows.map((r: any) => [normalize(r.barcode), r.loadedQty]));

  const progressItems = await Promise.all(items.map(async (item) => {
    const product = item.barcode ? await storage.getProductByBarcode(item.barcode) : undefined;
    const expected = item.quantity ?? 0;
    const loaded = loadedByBarcode.get(normalize(item.barcode)) ?? 0;
    const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, expected);
    let stockAvailable: number | null = null;
    if (item.barcode) {
      // Case/whitespace-insensitive plant match — proforma_slips.plant comes from whatever
      // casing the source (e.g. Notion's "Plant :"/"Stk Plant :") used ("VALSAD"), which won't
      // exact-match product_plant_stock's canonical casing ("Valsad") otherwise, causing a false
      // "no stock" even though Stock Overview (which already matches case-insensitively — see
      // server/routes/scan-sessions.ts) shows stock for the same plant.
      const { rows } = await pool.query(
        `SELECT in_stock AS "inStock" FROM product_plant_stock WHERE barcode = $1 AND LOWER(TRIM(plant)) = LOWER(TRIM($2))`,
        [item.barcode, slip.plant],
      );
      stockAvailable = rows[0]?.inStock ?? 0;
    }
    return {
      ...item, expected, loaded, remaining: Math.max(0, expected - loaded),
      itemsPerPallet, isComplete: expected > 0 && loaded >= expected, stockAvailable,
    };
  }));

  const allComplete = progressItems.length > 0 && progressItems.every((i) => i.isComplete);
  return { items: progressItems, allComplete };
}

// GET /api/loading/proforma/search?q=  — suggestions dropdown while typing/scanning.
// Matches partial order number OR party name, newest first, capped small (a dropdown, not a
// report). Raw SQL here (not storage.listProformaSlips, which has no search) — a small,
// self-contained query rather than a new IStorage method for a single lookup.
router.get('/loading/proforma/search', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const { rows } = await pool.query(
      `SELECT id, order_number AS "orderNumber", party_name AS "partyName", plant, order_date AS "orderDate",
              vehicle_number AS "vehicleNumber"
       FROM proforma_slips
       WHERE order_number ILIKE $1 OR party_name ILIKE $1
       ORDER BY created_at DESC
       LIMIT 8`,
      [`%${q}%`],
    );
    res.json({ results: rows });
  } catch (error) {
    console.error('Error searching proforma slips for loading:', error);
    res.status(500).json({ message: 'Failed to search proforma slips' });
  }
});

// GET /api/loading/proforma/:orderNumber — exact fetch, used once a barcode scan (camera or
// gun) or an Enter/suggestion-pick resolves to a specific order number.
router.get('/loading/proforma/:orderNumber', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    const rawItems = await storage.getProformaSlipItems(slip.id);
    const { items, allComplete } = await withProgress(slip, rawItems);
    res.json({ slip: await withRto(slip), items, allComplete });
  } catch (error) {
    console.error('Error fetching proforma slip for loading:', error);
    res.status(500).json({ message: 'Failed to fetch proforma slip' });
  }
});

// GET /api/loading/vehicles/search?q=  — suggestions dropdown for the vehicle picker. Matches
// against vehicle number, driver, company, or manufacturer — "anything user can enter", per
// spec. Vehicle Master is small enough (tens–low hundreds of rows) that filtering the already-
// fetched list in memory is simpler and fast enough than building a dedicated SQL search.
router.get('/loading/vehicles/search', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (q.length < 1) return res.json({ results: [] });
    const all = await storage.getAllVehicleInfo();
    const results = all
      .filter((v) =>
        [v.vehicleNumber, v.driver, v.company, v.manufacturer, v.series, v.rtoNumber]
          .some((f) => (f ?? '').toLowerCase().includes(q)))
      .slice(0, 8)
      .map((v) => ({
        id: v.id, vehicleNumber: v.vehicleNumber, rtoNumber: v.rtoNumber, driver: v.driver,
        company: v.company, manufacturer: v.manufacturer, volume: v.volume,
      }));
    res.json({ results });
  } catch (error) {
    console.error('Error searching vehicles for loading:', error);
    res.status(500).json({ message: 'Failed to search vehicles' });
  }
});

// GET /api/loading/records — the page's landing table. Admin/super-admin see every load
// anyone created; everyone else sees only their own (enforced server-side, not just hidden
// in the UI — a non-admin's request never even queries other users' rows). Server-paginated
// (20/page, matching Scan History) and enriched with the slip's live completion status so the
// client can show Reopen only where it applies, without a second round trip per row.
router.get('/loading/records', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const { userCode } = actor(req);
    const limit  = Math.max(1, Math.min(100, parseInt(String(req.query.limit  ?? '20'), 10) || 20));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const conditions: string[] = [];
    const params: any[] = [];
    if (!isAdmin(req)) {
      params.push(userCode);
      conditions.push(`lr.created_by_code = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT lr.id, lr.order_number AS "orderNumber", lr.proforma_slip_id AS "proformaSlipId",
                lr.party_name AS "partyName", lr.plant, lr.vehicle_number AS "vehicleNumber",
                lr.rto_number AS "rtoNumber", lr.volume, lr.created_by_code AS "createdByCode",
                lr.created_by_name AS "createdByName", lr.created_at AS "createdAt",
                ps.loading_completed_at AS "loadingCompletedAt"
         FROM loading_records lr
         LEFT JOIN proforma_slips ps ON ps.order_number = lr.order_number
         ${where}
         ORDER BY lr.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      pool.query(`SELECT COUNT(*) AS total FROM loading_records lr ${where}`, params),
    ]);

    res.json({
      records: dataRes.rows,
      total: parseInt(countRes.rows[0]?.total ?? '0', 10),
      limit, offset,
    });
  } catch (error) {
    console.error('Error listing loading records:', error);
    res.status(500).json({ message: 'Failed to fetch loading records' });
  }
});

// POST /api/loading/proforma/:orderNumber/link-vehicle  — body: { vehicleNumber }
// Writes vehicleNumber + totalVolume (from Vehicle Master) onto the proforma slip. The FIRST
// assignment is open to anyone with write access to Loading; once a vehicle is assigned,
// changing it again is restricted to whoever assigned it or an admin (see vehicleAssignedByCode
// in shared/schema.ts) — enforced here, not just hidden client-side.
router.post('/loading/proforma/:orderNumber/link-vehicle', requirePageWrite('loading'), async (req: Request, res: Response) => {
  try {
    const vehicleNumber = String(req.body?.vehicleNumber ?? '').trim();
    if (!vehicleNumber) return res.status(400).json({ message: 'vehicleNumber is required' });

    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });

    const { userCode, userName } = actor(req);
    const alreadyAssigned = !!slip.vehicleNumber && !!(slip as any).vehicleAssignedByCode;
    if (alreadyAssigned && !isAdmin(req) && (slip as any).vehicleAssignedByCode !== userCode) {
      return res.status(403).json({ message: 'Only the person who assigned this vehicle, or an admin, can change it.' });
    }

    const vehicle = await storage.getVehicleInfoByVehicleNumber(vehicleNumber);
    if (!vehicle) return res.status(404).json({ message: `No vehicle found in Vehicle Master with number "${vehicleNumber}"` });

    const updated = await storage.updateProformaSlip(slip.id, {
      vehicleNumber: vehicle.vehicleNumber,
      totalVolume: vehicle.volume != null ? String(vehicle.volume) : slip.totalVolume,
      vehicleAssignedByCode: userCode ?? null,
    } as any);
    if (!updated) return res.status(500).json({ message: 'Failed to link vehicle to proforma slip' });

    if (userCode) {
      await storage.logActivity({
        pageName: 'Loading', action: 'update', entityType: 'proforma_slip', entityId: slip.id,
        details: `Vehicle ${vehicle.vehicleNumber} linked to order ${slip.orderNumber} by ${userName ?? userCode}`,
        userCode, userName,
      });
    }

    // A history row for this action — this is what the Loading page's landing table lists.
    // Snapshotted, not a live join (see shared/schema.ts's loadingRecords comment).
    await storage.createLoadingRecord({
      orderNumber: updated.orderNumber, proformaSlipId: updated.id,
      partyName: updated.partyName, plant: updated.plant,
      vehicleNumber: vehicle.vehicleNumber, rtoNumber: vehicle.rtoNumber ?? null,
      volume: vehicle.volume != null ? String(vehicle.volume) : null,
      createdByCode: userCode ?? null, createdByName: userName ?? null,
    });

    res.json({ slip: await withRto(updated), vehicle });
  } catch (error) {
    console.error('Error linking vehicle to proforma slip:', error);
    res.status(500).json({ message: 'Failed to link vehicle' });
  }
});

// POST /api/loading/proforma/:orderNumber/scan  — body: { barcode, qty }
// The actual "remove stock and load it onto the vehicle" step. qty is already resolved
// client-side (pallets × itemsPerPallet + loose, or a full-pallet auto-scan amount) — this
// endpoint independently re-validates against the same rules Order Scan uses server-side.
router.post('/loading/proforma/:orderNumber/scan', requirePageWrite('loading'), async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const barcode = String(req.body?.barcode ?? '').trim();
    const qty = Math.round(Number(req.body?.qty));
    if (!barcode) return res.status(400).json({ message: 'barcode is required' });
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ message: 'qty must be a positive number' });

    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if ((slip as any).loadingCompletedAt) {
      return res.status(409).json({ message: 'This load is already marked complete — reopen it before scanning more.' });
    }
    // Vehicle must be linked before any item can be scanned onto it — enforced here too, not
    // just hidden client-side, so a stale/bypassed client can't scan against an unassigned slip.
    if (!slip.vehicleNumber) {
      return res.status(400).json({ message: 'Link a vehicle to this order before scanning items.' });
    }

    const rawItems = await storage.getProformaSlipItems(slip.id);
    const matchedItem = rawItems.find((i) => normalize(i.barcode) === normalize(barcode));
    const product = await storage.getProductByBarcode(barcode);

    // Not on this slip AND not a known product at all — same refusal Order Scan gives for a
    // barcode it has no record of whatsoever, rather than quietly logging it as an extra.
    if (!matchedItem && !product) {
      return res.status(400).json({ message: 'Barcode not in system — not on this order and not in Product Master.' });
    }

    // Stock check — the actual ask: an item already at zero (or short) for this plant cannot
    // be loaded. Checked against the live ledger, not the proforma's planned quantity.
    // Case/whitespace-insensitive match — see the comment on the identical query in
    // withProgress() above for why (Notion-imported slip.plant casing vs. canonical
    // product_plant_stock.plant casing).
    const { rows: stockRows } = await client.query(
      `SELECT in_stock AS "inStock" FROM product_plant_stock WHERE barcode = $1 AND LOWER(TRIM(plant)) = LOWER(TRIM($2))`,
      [barcode, slip.plant],
    );
    const inStock = stockRows[0]?.inStock ?? 0;
    if (inStock <= 0) {
      return res.status(409).json({ message: `No stock available to load "${matchedItem?.itemName ?? product?.name ?? barcode}" at ${slip.plant} — current stock is 0.` });
    }
    if (qty > inStock) {
      return res.status(409).json({ message: `Only ${inStock} in stock at ${slip.plant} — cannot load ${qty}.` });
    }

    // Same "split into a regular portion (capped at expected) + an extra portion" rule Order
    // Scan uses (server/routes/order-scan.ts) — a single scan can legitimately be part
    // regular, part extra, e.g. expected 10 / already loaded 8 / scanning 5 → 2 regular + 3 extra.
    const { rows: loadedRows } = await client.query(
      `SELECT COALESCE(SUM(total_qty), 0)::int AS "loaded" FROM loading_scan_events
       WHERE order_number = $1 AND barcode = $2 AND voided IS NOT TRUE`,
      [slip.orderNumber, barcode],
    );
    const alreadyLoaded = loadedRows[0]?.loaded ?? 0;
    const expected = matchedItem?.quantity ?? 0;
    const remainingBefore = matchedItem ? Math.max(0, expected - alreadyLoaded) : 0;
    const regularQty = matchedItem ? Math.min(qty, remainingBefore) : 0;
    const extraQty = qty - regularQty;

    // Same itemsPerPallet the Items table already shows for this row (withProgress uses the
    // identical resolvePalletSizeOrQty(product, state, expected) call) — so a scan's pallets/
    // loose split here always agrees with what the page displays, and with how Order Scan
    // splits its own events (server/routes/order-scan.ts's writeScanEvents).
    const state = await getPlantStateCode(client, slip.plant ?? '');
    const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, expected);

    const { userCode, userName } = actor(req);
    await client.query('BEGIN');
    try {
      const insertEvent = (totalQty: number, isExtra: boolean) => client.query(
        `INSERT INTO loading_scan_events
           (order_number, proforma_slip_id, barcode, item_name, sap_code, pallets, loose_qty, total_qty, is_extra, plant, scanned_by_code, scanned_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          slip.orderNumber, slip.id, barcode, matchedItem?.itemName ?? product?.name ?? null, matchedItem?.sapCode ?? product?.sapCode ?? null,
          itemsPerPallet > 0 ? Math.floor(totalQty / itemsPerPallet) : 0,
          itemsPerPallet > 0 ? totalQty % itemsPerPallet : totalQty,
          totalQty, isExtra, slip.plant, userCode ?? null, userName ?? null,
        ],
      );
      if (regularQty > 0) await insertEvent(regularQty, false);
      if (extraQty > 0) await insertEvent(extraQty, true);

      // Case/whitespace-insensitive match, same as the stock check above — an exact match here
      // would silently update 0 rows (stock never actually decremented) even after the check
      // above passed, if slip.plant's casing doesn't match product_plant_stock's.
      await client.query(
        `UPDATE product_plant_stock SET in_stock = in_stock - $1, updated_at = NOW() WHERE barcode = $2 AND LOWER(TRIM(plant)) = LOWER(TRIM($3))`,
        [qty, barcode, slip.plant],
      );
      await client.query(
        `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code)
         VALUES ($1,$2,$3,$4,$5,'dispatch',$6,$7)`,
        [barcode, product?.id ?? null, slip.plant, -qty, extraQty, `Loaded onto vehicle for order ${slip.orderNumber}`, userCode ?? null],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    const { items: progressItems, allComplete } = await withProgress(slip, rawItems);

    // Auto-complete — "complete also auto if all item load". Attributed to whoever's scan
    // finished it (more useful than a bare "system" marker), only fires once.
    let finalSlip: any = slip;
    if (allComplete && !(slip as any).loadingCompletedAt) {
      finalSlip = await storage.updateProformaSlip(slip.id, {
        loadingCompletedAt: new Date(), loadingCompletedByCode: userCode ?? null,
      } as any) ?? slip;
    }

    res.json({
      slip: await withRto(finalSlip), items: progressItems, allComplete,
      event: {
        barcode, itemName: matchedItem?.itemName ?? product?.name ?? barcode,
        sapCode: matchedItem?.sapCode ?? product?.sapCode ?? null,
        totalQty: qty, isExtra: extraQty > 0, remaining: Math.max(0, remainingBefore - regularQty),
      },
    });
  } catch (error) {
    console.error('Error scanning item for loading:', error);
    res.status(500).json({ message: 'Failed to record scan' });
  } finally {
    client.release();
  }
});

// POST /api/loading/proforma/:orderNumber/complete — manual override, same designation-based
// permission Order Scan uses for its Complete button ("complete button if not loaded, same as
// Order Scan") — works even if items are still short, unlike the automatic path above.
router.post('/loading/proforma/:orderNumber/complete', requirePageWrite('loading'), requireCompleteLoadAccess, async (req: Request, res: Response) => {
  try {
    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });

    const { userCode, userName } = actor(req);
    const updated = await storage.updateProformaSlip(slip.id, {
      loadingCompletedAt: new Date(), loadingCompletedByCode: userCode ?? null,
    } as any);
    if (!updated) return res.status(500).json({ message: 'Failed to complete load' });

    if (userCode) {
      await storage.logActivity({
        pageName: 'Loading', action: 'update', entityType: 'proforma_slip', entityId: slip.id,
        details: `Load for order ${slip.orderNumber} marked complete by ${userName ?? userCode}`,
        userCode, userName,
      });
    }

    const rawItems = await storage.getProformaSlipItems(slip.id);
    const { items, allComplete } = await withProgress(updated, rawItems);
    res.json({ slip: await withRto(updated), items, allComplete });
  } catch (error) {
    console.error('Error completing load:', error);
    res.status(500).json({ message: 'Failed to complete load' });
  }
});

// POST /api/loading/proforma/:orderNumber/reopen — undoes Complete (auto or manual), same
// permission as Complete itself. Purely a status flip: clears loadingCompletedAt/By so the order
// can be scanned again; nothing else about the load (items already scanned, vehicle) is touched.
router.post('/loading/proforma/:orderNumber/reopen', requirePageWrite('loading'), requireCompleteLoadAccess, async (req: Request, res: Response) => {
  try {
    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });

    const { userCode, userName } = actor(req);
    const updated = await storage.updateProformaSlip(slip.id, {
      loadingCompletedAt: null, loadingCompletedByCode: null,
    } as any);
    if (!updated) return res.status(500).json({ message: 'Failed to reopen load' });

    if (userCode) {
      await storage.logActivity({
        pageName: 'Loading', action: 'update', entityType: 'proforma_slip', entityId: slip.id,
        details: `Load for order ${slip.orderNumber} reopened by ${userName ?? userCode}`,
        userCode, userName,
      });
    }

    const rawItems = await storage.getProformaSlipItems(slip.id);
    const { items, allComplete } = await withProgress(updated, rawItems);
    res.json({ slip: await withRto(updated), items, allComplete });
  } catch (error) {
    console.error('Error reopening load:', error);
    res.status(500).json({ message: 'Failed to reopen load' });
  }
});

// POST /api/loading/proforma/:orderNumber/reset — the landing table's "Delete" action: undoes
// everything Loading has done for this order, as if it was never touched. Same permission as
// voiding a single load event (this is exactly that, applied to every row for the order at once):
//   1. Every non-voided loading_scan_events row for this order is reversed (stock added back to
//      product_plant_stock, a correcting stock_movements row logged) and marked voided — same
//      audit-preserving pattern as POST /events/:id/void, never physically deleted.
//   2. The vehicle link is cleared (vehicleNumber/vehicleAssignedByCode/totalVolume) and the
//      completed status is cleared — the slip goes back to "no vehicle assigned yet".
//   3. The loading_records row(s) for this order (the landing table's own history log) ARE
//      physically deleted — that table is just a log of "a vehicle was linked", which is no
//      longer true once step 2 undoes it; nothing about it needs to survive as audit history the
//      way the underlying stock-affecting scan events do.
router.post('/loading/proforma/:orderNumber/reset', requireLoadingVoidAccess, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });

    const { userCode, userName } = actor(req);
    await client.query('BEGIN');

    const { rows: events } = await client.query(
      `SELECT * FROM loading_scan_events WHERE order_number = $1 AND voided IS NOT TRUE FOR UPDATE`,
      [slip.orderNumber],
    );
    for (const event of events) {
      const qty = Number(event.total_qty ?? 0);
      if (qty > 0 && event.plant && event.barcode) {
        const product = await storage.getProductByBarcode(event.barcode);
        await client.query(
          `UPDATE product_plant_stock SET in_stock = in_stock + $1, updated_at = NOW()
           WHERE barcode = $2 AND LOWER(TRIM(plant)) = LOWER(TRIM($3))`,
          [qty, event.barcode, event.plant],
        );
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code)
           VALUES ($1,$2,$3,$4,0,'adjust',$5,$6)`,
          [event.barcode, product?.id ?? null, event.plant, qty, `Loading slip ${slip.orderNumber} reset — deleted from landing table`, userCode ?? null],
        );
      }
      await client.query(
        `UPDATE loading_scan_events SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2 WHERE id = $3`,
        [userCode ?? null, 'Loading slip reset (deleted from landing table)', event.id],
      );
    }

    await client.query(
      `UPDATE proforma_slips
       SET vehicle_number = NULL, vehicle_assigned_by_code = NULL, total_volume = NULL,
           loading_completed_at = NULL, loading_completed_by_code = NULL
       WHERE id = $1`,
      [slip.id],
    );
    await client.query(`DELETE FROM loading_records WHERE order_number = $1`, [slip.orderNumber]);

    await client.query('COMMIT');

    if (userCode) {
      await storage.logActivity({
        pageName: 'Loading', action: 'delete', entityType: 'proforma_slip', entityId: slip.id,
        details: `Loading reset for order ${slip.orderNumber} by ${userName ?? userCode} — ${events.length} scan(s) voided, vehicle un-assigned`,
        userCode, userName,
      });
    }

    res.json({ success: true, reversedEvents: events.length });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error resetting loading slip:', error);
    res.status(500).json({ message: 'Failed to reset loading slip' });
  } finally {
    client.release();
  }
});

// POST /api/loading/events/:id/void — the Load Event tab's Void action (Scan History page).
// Marks a single loading_scan_events row as a mistake: stays in history (never deleted), but its
// quantity is reversed back into product_plant_stock — the mirror image of what /scan's decrement
// did, since a loading scan REMOVES stock rather than adding it (unlike order_scan_events' void,
// which subtracts back out — see reverseLiveScanStock in server/lib/orderGroupReport.ts). No
// order_scan_items-style item record to reconcile here (withProgress recomputes "loaded" live by
// summing non-voided rows), so this is simpler than order-scan's void: no FIFO credit transfer,
// no same-part Extra backfill — just reverse the stock and mark the row.
router.post('/loading/events/:id/void', requireLoadingVoidAccess, async (req: Request, res: Response) => {
  const eventId = parseInt(req.params.id);
  if (isNaN(eventId)) return res.status(400).json({ message: 'Invalid event ID' });

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;
  const { userCode } = actor(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: eventRows } = await client.query(
      `SELECT * FROM loading_scan_events WHERE id = $1 FOR UPDATE`,
      [eventId],
    );
    const event = eventRows[0];
    if (!event) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Load event not found' });
    }
    if (event.voided) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This scan is already voided' });
    }

    const qty = Number(event.total_qty ?? 0);
    if (qty > 0 && event.plant && event.barcode) {
      const product = await storage.getProductByBarcode(event.barcode);
      await client.query(
        `UPDATE product_plant_stock SET in_stock = in_stock + $1, updated_at = NOW()
         WHERE barcode = $2 AND LOWER(TRIM(plant)) = LOWER(TRIM($3))`,
        [qty, event.barcode, event.plant],
      );
      await client.query(
        `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code)
         VALUES ($1,$2,$3,$4,0,'adjust',$5,$6)`,
        [event.barcode, product?.id ?? null, event.plant, qty, `Voided load scan for order ${event.order_number}`, userCode ?? null],
      );
    }

    const { rows: voidRows } = await client.query(
      `UPDATE loading_scan_events
       SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2
       WHERE id = $3
       RETURNING *`,
      [userCode ?? null, reason, eventId],
    );

    await client.query('COMMIT');

    // A voided scan can drop an order below fully-loaded again — if it had auto- or manually-
    // completed, clear that now rather than leaving the list showing "Complete" for an order
    // that's actually short again. Mirrors the auto-complete side effect in /scan the other way
    // around; done after COMMIT so it reads the just-voided row rather than a stale snapshot.
    const slip = await storage.getProformaSlipByOrderNumber(event.order_number);
    if (slip && (slip as any).loadingCompletedAt) {
      const rawItems = await storage.getProformaSlipItems(slip.id);
      const { allComplete } = await withProgress(slip, rawItems);
      if (!allComplete) {
        await storage.updateProformaSlip(slip.id, {
          loadingCompletedAt: null, loadingCompletedByCode: null,
        } as any);
      }
    }

    res.json({ event: voidRows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error voiding load event:', error);
    res.status(500).json({ message: 'Failed to void load event' });
  } finally {
    client.release();
  }
});

export default router;
