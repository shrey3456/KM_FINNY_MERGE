import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { requirePageAccess, requirePageWrite, WRITE_ADMIN_ROLES } from '../lib/pageAccess';
import { getUserPlants, getPlantStateCode, getPalletSize } from './order-scan';
import { applyColumnFiltersToSql, type SqlFilterColumn } from '../lib/columnFilterSql';

// Sort Slip — godown picking.
//
// A supervisor turns a proforma order into a sort slip, puts one or more loaders on it, and each
// loader records how much of every product they have physically picked. There is no scanning
// here at all: the quantity is typed, the same way the Loading page's +/- correction dialog
// works, because the people doing this job are sorting cartons onto a platform, not scanning
// them onto a truck.
//
// THIS IS NOT A LOAD OPERATION. A sort slip shares only the order number with Loading. A pick is
// written to sort_slip_picks and nowhere else — it moves no stock, writes no loading_scan_events,
// and is invisible to Load Operations' loaded quantity, Scan History and Stock Overview. Sorting
// says "this much has been brought to the platform"; loading says "this much went on the truck".
// Counting one as the other would double-count the same cartons.
//
// Permissions, all enforced here rather than by hiding buttons:
//   • write access on 'sort-slip'  → create, transfer, complete, reopen, delete, void
//   • view access + being an ASSIGNEE of this slip → record a pick on it, void your own
//   • view access alone → see only the slips you are assigned to
// Who can be ASSIGNED is the same grant and nothing else — view access to this page. Department
// and designation play no part.
//
// A slip holds exactly ONE loader at a time: it cannot be created without one, and the only way
// the work changes hands is a supervisor's transfer. sort_slip_assignees stays a table rather
// than a column on the slip because its rows are the record of who held it and when — which is
// what keeps each loader's picks attributable after the slip has moved on.
// The middle rule is the one deliberate exception to the app's usual "view means read": loaders
// hold view access only, and recording their own pick is the single write it buys them.
const router = Router();

function actor(req: Request): { userCode: string; userName: string } {
  const u = req.user as any;
  return { userCode: u?.userCode ?? '', userName: u?.name || u?.username || u?.userCode || '' };
}

function isAdmin(req: Request): boolean {
  const role = ((req.user as any)?.role ?? '').toString().toLowerCase();
  return WRITE_ADMIN_ROLES.includes(role);
}

// Write access to this page specifically — the supervisor test. Same rule requirePageWrite
// applies, read here as a boolean so a single endpoint can serve both kinds of caller (the list
// shows every slip to a supervisor and only their own to a loader).
function hasWrite(req: Request): boolean {
  if (isAdmin(req)) return true;
  try {
    return (JSON.parse((req.user as any)?.pageWriteAccess || '[]') as string[]).includes('sort-slip');
  } catch {
    return false;
  }
}

const normalize = (value?: string | number | null) => String(value ?? '').trim().toLowerCase();

function canAccessPlant(req: Request, plant: string | null | undefined): boolean {
  const userPlants = getUserPlants(req.user);
  if (userPlants === null) return true;
  return userPlants.includes(normalize(plant));
}

// Whether a LOADER (not the caller) may work an order at this plant. A supervisor picking
// someone who has no access to the slip's plant used to succeed and then strand them: the slip
// never appeared in their list and every pick came back "Plant access required". They are now
// refused at assignment time, with a reason, instead of silently.
async function loaderCanAccessPlant(userCode: string, plant: string | null | undefined): Promise<boolean> {
  const { rows } = await pool.query(`SELECT role, plants FROM users WHERE user_code = $1`, [userCode]);
  if (!rows[0]) return false;
  const allowed = getUserPlants(rows[0]);
  if (allowed === null) return true;            // admin — every plant
  if (allowed.length === 0) return false;       // no plants granted at all
  return allowed.includes(normalize(plant));
}

// Whether this person is a LOADER: view access to Sort Slip, no write access, not an admin —
// the same definition the list above uses, so the server and the picker can never disagree.
// Returns why they are not, for the message the page shows.
async function loaderCheck(userCode: string): Promise<'ok' | 'access' | 'supervisor'> {
  const { rows } = await pool.query(
    `SELECT role, allowed_pages, page_write_access FROM users WHERE user_code = $1`, [userCode]);
  if (!rows[0]) return 'access';
  if (WRITE_ADMIN_ROLES.includes(String(rows[0].role ?? '').toLowerCase())) return 'supervisor';
  const parse = (value: string | null) => {
    try { return JSON.parse(value || '[]') as string[]; } catch { return []; }
  };
  if (!parse(rows[0].allowed_pages).includes('sort-slip')) return 'access';
  // Write access is what makes someone a supervisor. They assign the work; they are not given it.
  if (parse(rows[0].page_write_access).includes('sort-slip')) return 'supervisor';
  return 'ok';
}

// Is this user one of the loaders currently on this slip? The gate for picking.
async function isAssignee(sortSlipId: number, userCode: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM sort_slip_assignees
      WHERE sort_slip_id = $1 AND user_code = $2 AND removed_at IS NULL LIMIT 1`,
    [sortSlipId, userCode],
  );
  return rows.length > 0;
}

async function getSlipById(id: number): Promise<any | null> {
  const { rows } = await pool.query(`SELECT * FROM sort_slips WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// The loaders on a set of slips, in one query — the landing list would otherwise run one query
// per row just to draw the name chips.
async function assigneesFor(slipIds: number[]): Promise<Map<number, Array<{ userCode: string; userName: string | null }>>> {
  const map = new Map<number, Array<{ userCode: string; userName: string | null }>>();
  if (slipIds.length === 0) return map;
  const { rows } = await pool.query(
    `SELECT sort_slip_id AS "sortSlipId", user_code AS "userCode", user_name AS "userName"
       FROM sort_slip_assignees
      WHERE sort_slip_id = ANY($1::int[]) AND removed_at IS NULL
      ORDER BY assigned_at ASC`,
    [slipIds],
  );
  for (const row of rows) {
    const list = map.get(row.sortSlipId) ?? [];
    list.push({ userCode: row.userCode, userName: row.userName });
    map.set(row.sortSlipId, list);
  }
  return map;
}

// Turns the one-active-slip index's violation into something a supervisor can act on: which
// slip that loader is already on, by name and order number.
async function activeSlipOf(userCode: string): Promise<{ orderNumber: string; id: number } | null> {
  const { rows } = await pool.query(
    `SELECT s.id, s.order_number AS "orderNumber"
       FROM sort_slip_assignees a JOIN sort_slips s ON s.id = a.sort_slip_id
      WHERE a.user_code = $1 AND a.is_active LIMIT 1`,
    [userCode],
  );
  return rows[0] ?? null;
}

const ONE_ACTIVE_INDEX = 'sort_slip_one_active_per_loader';

// The columns the landing list's "+ Filter" chips may filter on. The list is paginated, so these
// are applied in SQL over the WHOLE set — filtering the page already fetched would leave later
// pages unfiltered (the bug that put a Load row on page 103 of a Scan-only Scan History filter).
// The id -> expression mapping is fixed here, so a request can never name a column of its own.
const SORT_SLIP_FILTER_COLUMNS: Record<string, SqlFilterColumn> = {
  orderNumber: { sql: 's.order_number', type: 'text' },
  partyName: { sql: 's.party_name', type: 'text' },
  plant: { sql: 's.plant', type: 'text' },
  orderDate: { sql: 's.order_date', type: 'date' },
  status: { sql: 's.status', type: 'text' },
  totalQty: { sql: 's.total_qty', type: 'number' },
  pickedQty: {
    sql: `COALESCE((SELECT SUM(p.qty) FROM sort_slip_picks p WHERE p.sort_slip_id = s.id AND NOT p.voided), 0)`,
    type: 'number',
  },
  // Matches on any loader currently on the slip, by name or by code.
  assignee: {
    sql: `COALESCE((SELECT string_agg(COALESCE(a.user_name, a.user_code), ', ')
                      FROM sort_slip_assignees a
                     WHERE a.sort_slip_id = s.id AND a.removed_at IS NULL), '')`,
    type: 'text',
  },
  createdByName: { sql: 's.created_by_name', type: 'text' },
};

// ─── Reads ───────────────────────────────────────────────────────────────────

// GET /sort-slips — the landing list.
// A supervisor sees every slip in their plants; a loader sees only the slips they are on. That
// scoping is done here, not in the page, so a loader cannot ask for someone else's list.
router.get('/sort-slips', requirePageAccess('sort-slip'), async (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '25'), 10) || 25));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const status = String(req.query.status ?? '').trim();
    const search = String(req.query.search ?? '').trim();
    const fromDate = String(req.query.fromDate ?? '').trim();
    const toDate = String(req.query.toDate ?? '').trim();

    const conditions: string[] = [];
    const params: any[] = [];

    const userPlants = getUserPlants(req.user);
    if (userPlants !== null) {
      params.push(userPlants);
      conditions.push(`LOWER(s.plant) = ANY($${params.length})`);
    }
    if (!hasWrite(req)) {
      params.push(actor(req).userCode);
      conditions.push(`EXISTS (SELECT 1 FROM sort_slip_assignees a
                                WHERE a.sort_slip_id = s.id AND a.user_code = $${params.length}
                                  AND a.removed_at IS NULL)`);
    }
    if (status) {
      params.push(status);
      conditions.push(`s.status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`(LOWER(s.order_number) LIKE $${params.length} OR LOWER(s.party_name) LIKE $${params.length})`);
    }
    if (fromDate) {
      params.push(fromDate);
      conditions.push(`s.order_date >= $${params.length}::date`);
    }
    if (toDate) {
      params.push(toDate);
      conditions.push(`s.order_date <= $${params.length}::date`);
    }
    // What this caller is allowed to see, before their own column filters narrow it: plant,
    // assignment, and the toolbar's status/search/date. The filter checklists are built from
    // THIS, so a filter never shrinks its own list of choices until nothing else can be picked.
    // TRUE rather than an empty string, so a query can always hang its own "AND ..." off it.
    const baseScope = conditions.length ? conditions.join(' AND ') : 'TRUE';
    const baseParamCount = params.length;
    applyColumnFiltersToSql(req.query.filters as string | undefined, SORT_SLIP_FILTER_COLUMNS, conditions, params);
    const where = `WHERE ${conditions.length ? conditions.join(' AND ') : 'TRUE'}`;

    params.push(limit, offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT s.id, s.order_number AS "orderNumber", s.proforma_slip_id AS "proformaSlipId",
                s.party_name AS "partyName", s.plant, s.order_date::text AS "orderDate",
                s.total_qty AS "totalQty", s.status, s.platform_stv AS "platformStv",
                s.created_by_name AS "createdByName", s.created_at AS "createdAt",
                s.activated_at AS "activatedAt",
                s.completed_at AS "completedAt", s.completed_by_name AS "completedByName",
                s.notes,
                COALESCE((SELECT SUM(p.qty) FROM sort_slip_picks p
                           WHERE p.sort_slip_id = s.id AND NOT p.voided), 0)::int AS "pickedQty"
           FROM sort_slips s
           ${where}
          ORDER BY (s.status = 'completed') ASC, s.created_at DESC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM sort_slips s ${where}`,
        params.slice(0, params.length - 2),
      ),
    ]);

    const byId = await assigneesFor(dataRes.rows.map((r: any) => r.id));

    // The values the filter checklists offer. Drawn from every slip this caller may see — not
    // from the page on screen — so ticking a value can actually find rows on another page.
    const optionParams = params.slice(0, baseParamCount);
    const optionsRes = await pool.query(
      `SELECT ARRAY(SELECT DISTINCT s.plant FROM sort_slips s WHERE ${baseScope} AND s.plant IS NOT NULL ORDER BY s.plant) AS plants,
              ARRAY(SELECT DISTINCT s.party_name FROM sort_slips s WHERE ${baseScope} AND s.party_name IS NOT NULL ORDER BY s.party_name) AS parties,
              ARRAY(SELECT DISTINCT s.status FROM sort_slips s WHERE ${baseScope} ORDER BY s.status) AS statuses,
              ARRAY(SELECT DISTINCT s.order_date::text FROM sort_slips s WHERE ${baseScope} AND s.order_date IS NOT NULL ORDER BY s.order_date::text DESC) AS dates,
              ARRAY(SELECT DISTINCT COALESCE(a.user_name, a.user_code) FROM sort_slip_assignees a
                     WHERE a.removed_at IS NULL
                       AND a.sort_slip_id IN (SELECT s.id FROM sort_slips s WHERE ${baseScope})
                     ORDER BY 1) AS assignees`,
      optionParams,
    );

    res.json({
      records: dataRes.rows.map((row: any) => ({ ...row, assignees: byId.get(row.id) ?? [] })),
      total: countRes.rows[0]?.total ?? 0,
      limit, offset,
      canWrite: hasWrite(req),
      filterValues: {
        plant: optionsRes.rows[0]?.plants ?? [],
        partyName: optionsRes.rows[0]?.parties ?? [],
        status: optionsRes.rows[0]?.statuses ?? [],
        orderDate: optionsRes.rows[0]?.dates ?? [],
        assignee: optionsRes.rows[0]?.assignees ?? [],
      },
    });
  } catch (error) {
    console.error('[Sort Slip] list failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to load sort slips' });
  }
});

// GET /sort-slips/loaders?plant=VALSAD — the loaders a slip can be given to.
//
// A LOADER is someone with VIEW access to Sort Slip and no write access: view access is exactly
// what lets a person open a slip assigned to them and record picks. Write access makes someone a
// SUPERVISOR — the person doing the assigning — and admins are supervisors everywhere, so neither
// appears in this list. Department and designation are not consulted at all: who picks is decided
// by the grant on User Management, not by how a record happens to be labelled.
//
// They must also hold the order's plant, which is applied below — so every name here is a name
// that can actually be assigned.
//
// `plant` is optional only for the case where no order has been chosen yet.
router.get('/sort-slips/loaders', requirePageWrite('sort-slip'), async (req: Request, res: Response) => {
  try {
    const plant = String(req.query.plant ?? '').trim();
    const { rows } = await pool.query(
      `SELECT u.user_code AS "userCode", u.name, u.username, u.department, u.designation,
              u.plants, u.role,
              a.sort_slip_id AS "activeSlipId", s.order_number AS "activeOrderNumber"
         FROM users u
         LEFT JOIN sort_slip_assignees a ON a.user_code = u.user_code AND a.is_active
         LEFT JOIN sort_slips s ON s.id = a.sort_slip_id
        WHERE COALESCE(u.allowed_pages, '') LIKE '%sort-slip%'
          AND COALESCE(u.page_write_access, '') NOT LIKE '%sort-slip%'
          AND NOT (LOWER(COALESCE(u.role, '')) = ANY($1))
        ORDER BY u.name NULLS LAST, u.username`,
      [WRITE_ADMIN_ROLES],
    );

    // The plant test runs here rather than in SQL: users.plants is free-form text holding JSON
    // (and a few rows hold a malformed version of it), so it is read with the same parser the
    // rest of the app uses instead of being pattern-matched in the query.
    const list = plant
      ? rows.filter((row: any) => {
          const allowed = getUserPlants(row);
          return allowed === null || allowed.includes(normalize(plant));
        })
      : rows;
    res.json(list);
  } catch (error) {
    console.error('[Sort Slip] loaders failed:', error);
    res.status(500).json({ message: 'Failed to load the loader list' });
  }
});

// GET /sort-slips/orders/search — proforma orders that can become a sort slip.
// Orders that already have one are returned too, flagged, rather than hidden: "it's already
// sorted" is a more useful answer than an empty result.
router.get('/sort-slips/orders/search', requirePageWrite('sort-slip'), async (req: Request, res: Response) => {
  try {
    const term = String(req.query.q ?? '').trim();
    const params: any[] = [];
    const conditions: string[] = [];

    const userPlants = getUserPlants(req.user);
    if (userPlants !== null) {
      params.push(userPlants);
      conditions.push(`LOWER(ps.plant) = ANY($${params.length})`);
    }
    if (term) {
      params.push(`%${term.toLowerCase()}%`);
      conditions.push(`(LOWER(ps.order_number) LIKE $${params.length} OR LOWER(ps.party_name) LIKE $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT ps.id, ps.order_number AS "orderNumber", ps.party_name AS "partyName",
              ps.plant, ps.order_date::text AS "orderDate", ps.total_volume AS "totalVolume",
              COALESCE((SELECT SUM(i.quantity) FROM proforma_slip_items i
                         WHERE i.proforma_slip_id = ps.id), 0)::int AS "totalQty",
              (SELECT COUNT(*) FROM proforma_slip_items i WHERE i.proforma_slip_id = ps.id)::int AS "itemCount",
              (SELECT ss.id FROM sort_slips ss WHERE ss.order_number = ps.order_number) AS "existingSortSlipId"
         FROM proforma_slips ps
         ${where}
        ORDER BY ps.order_date DESC NULLS LAST, ps.id DESC
        LIMIT 25`,
      params,
    );
    res.json(rows);
  } catch (error) {
    console.error('[Sort Slip] order search failed:', error);
    res.status(500).json({ message: 'Failed to search orders' });
  }
});

// GET /sort-slips/orders/:orderNumber/preview — what the create popup shows.
//
// The order's own header and item list, read straight from the proforma slip, because at this
// point no sort slip exists yet to read them through. Same shape as the create card on the
// Loading page: a supervisor sees what they are about to hand out before they hand it out.
router.get('/sort-slips/orders/:orderNumber/preview', requirePageWrite('sort-slip'), async (req: Request, res: Response) => {
  try {
    const orderNumber = decodeURIComponent(req.params.orderNumber);
    const { rows } = await pool.query(
      `SELECT ps.id, ps.order_number AS "orderNumber", ps.party_name AS "partyName", ps.plant,
              ps.order_date::text AS "orderDate", ps.total_volume AS "totalVolume",
              COALESCE((SELECT SUM(i.quantity) FROM proforma_slip_items i
                         WHERE i.proforma_slip_id = ps.id), 0)::int AS "totalQty",
              (SELECT ss.id FROM sort_slips ss WHERE ss.order_number = ps.order_number) AS "existingSortSlipId"
         FROM proforma_slips ps WHERE ps.order_number = $1 ORDER BY ps.id DESC LIMIT 1`,
      [orderNumber],
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ message: `No proforma slip found for order ${orderNumber}` });
    if (!canAccessPlant(req, order.plant)) {
      return res.status(403).json({ message: 'This order belongs to a plant you do not have access to' });
    }

    const items = await pool.query(
      `SELECT i.id, i.sr_no AS "srNo", i.barcode, i.item_name AS "itemName",
              COALESCE(i.quantity, 0)::int AS "quantity"
         FROM proforma_slip_items i WHERE i.proforma_slip_id = $1
        ORDER BY i.sr_no NULLS LAST, i.id`,
      [order.id],
    );
    res.json({ order, items: items.rows });
  } catch (error) {
    console.error('[Sort Slip] order preview failed:', error);
    res.status(500).json({ message: 'Failed to read the order' });
  }
});

// GET /sort-slips/by-order/:orderNumber/loader-history — for the LOADING page, not this one.
//
// Loading shows a collapsed "Owner history" line for who has held a load; this is the same idea
// for sorting — "who picked this order and how much" — surfaced next to it. Gated on 'loading' OR
// 'sort-slip' page access rather than requiring Sort Slip access on its own: someone working the
// Loading page has a legitimate reason to see who sorted the order they are about to load, without
// also needing a separate Sort Slip grant. Never 404s for "no sort slip" — that is a normal case
// (most orders are loaded without ever being sorted), reported as exists:false, not an error.
router.get('/sort-slips/by-order/:orderNumber/loader-history', requirePageAccess(['loading', 'sort-slip']), async (req: Request, res: Response) => {
  try {
    const orderNumber = decodeURIComponent(req.params.orderNumber);
    const { rows } = await pool.query(`SELECT * FROM sort_slips WHERE order_number = $1`, [orderNumber]);
    const slip = rows[0];
    if (!slip) return res.json({ exists: false });
    if (!canAccessPlant(req, slip.plant)) {
      return res.status(403).json({ message: 'This order belongs to a plant you do not have access to' });
    }

    const timeline = await pool.query(
      `SELECT a.user_code AS "userCode", a.user_name AS "userName",
              a.assigned_at AS "from", a.removed_at AS "to",
              COALESCE((SELECT SUM(p.qty) FROM sort_slip_picks p
                         WHERE p.sort_slip_id = a.sort_slip_id
                           AND p.picked_by_code = a.user_code
                           AND NOT p.voided
                           AND p.picked_at >= a.assigned_at
                           AND (a.removed_at IS NULL OR p.picked_at < a.removed_at)), 0)::int AS "pickedQty"
         FROM sort_slip_assignees a
        WHERE a.sort_slip_id = $1
        ORDER BY a.assigned_at ASC`,
      [slip.id],
    );
    const totalPicked = await pool.query(
      `SELECT COALESCE(SUM(qty), 0)::int AS picked FROM sort_slip_picks WHERE sort_slip_id = $1 AND NOT voided`,
      [slip.id],
    );

    res.json({
      exists: true,
      status: slip.status,
      totalQty: slip.total_qty,
      pickedQty: totalPicked.rows[0]?.picked ?? 0,
      timeline: timeline.rows,
    });
  } catch (error) {
    console.error('[Sort Slip] loader history for Loading failed:', error);
    res.status(500).json({ message: 'Failed to load the sort history for this order' });
  }
});

// GET /sort-slips/:orderNumber — the slip itself, its items and its people.
// Each item carries the product's id and whether a box photo is cached for it, so the item list
// can show the carton picture people actually recognise a product by.
router.get('/sort-slips/:orderNumber', requirePageAccess('sort-slip'), async (req: Request, res: Response) => {
  try {
    const orderNumber = decodeURIComponent(req.params.orderNumber);
    const { rows } = await pool.query(
      `SELECT s.*, s.order_date::text AS order_date_text FROM sort_slips s WHERE s.order_number = $1`,
      [orderNumber],
    );
    const slip = rows[0];
    if (!slip) return res.status(404).json({ message: 'No sort slip for this order' });
    if (!canAccessPlant(req, slip.plant)) {
      return res.status(403).json({ message: 'This order belongs to a plant you do not have access to' });
    }
    const mine = await isAssignee(slip.id, actor(req).userCode);
    if (!hasWrite(req) && !mine) {
      return res.status(403).json({ message: 'This sort slip is not assigned to you' });
    }

    const [itemsRes, assigneeRes, timelineRes] = await Promise.all([
      pool.query(
        `SELECT i.id, i.sr_no AS "srNo", i.barcode, i.sap_code AS "sapCode", i.item_name AS "itemName",
                COALESCE(i.quantity, 0)::int AS "expectedQty",
                COALESCE((SELECT SUM(p.qty) FROM sort_slip_picks p
                           WHERE p.proforma_slip_item_id = i.id AND NOT p.voided), 0)::int AS "pickedQty",
                prod.id AS "productId",
                -- The pallet size is a per-STATE fact (GJ PLT / VAL PLT vs MP PLT / IND PLT), so
                -- both columns come back and the plant's state picks between them below — the
                -- same rule Order Scan and Loading use, so a pallet means the same thing here.
                prod.gj_plt AS "gjPlt", prod.mp_plt AS "mpPlt",
                (prod.box_image IS NOT NULL) AS "hasBoxImage",
                (prod.product_image IS NOT NULL) AS "hasProductImage"
           FROM proforma_slip_items i
           LEFT JOIN LATERAL (
             -- The product row this line means: prefer its own product_id, but only when that id
             -- still resolves to a real row — proforma_slip_items.product_id is a snapshot taken
             -- at import time (see its own comment in shared/schema.ts: "soft reference only"),
             -- and Product Master reassigns fresh ids on a full sync, so an old order's stored id
             -- can point at nothing at all. When it doesn't resolve, fall back to the barcode —
             -- not only when product_id was NULL to begin with — preferring a row for this
             -- order's plant (a barcode can be entered once per plant). Display never depends on
             -- this — the line's own snapshot does — it is only how the picture is found.
             SELECT p.id, p.box_image, p.product_image, p.gj_plt, p.mp_plt
               FROM products p
              WHERE p.id = i.product_id
                 OR LOWER(p.barcode) = LOWER(i.barcode)
              ORDER BY (p.id = i.product_id) DESC,
                       (LOWER(COALESCE(p.plant, '')) = LOWER($2)) DESC,
                       p.id ASC
              LIMIT 1
           ) prod ON TRUE
          WHERE i.proforma_slip_id = $1
          ORDER BY i.sr_no NULLS LAST, i.id`,
        [slip.proforma_slip_id, slip.plant ?? ''],
      ),
      pool.query(
        `SELECT user_code AS "userCode", user_name AS "userName", assigned_at AS "assignedAt",
                assigned_by_name AS "assignedByName", is_active AS "isActive"
           FROM sort_slip_assignees
          WHERE sort_slip_id = $1 AND removed_at IS NULL ORDER BY assigned_at ASC`,
        [slip.id],
      ),
      // Everyone who has held this slip, oldest first, with how much each of them picked while
      // they had it — the same "the owner is an array" summary the Loading page shows for a load.
      // Display only: nothing about access reads this, only the slip's current assignee does.
      pool.query(
        `SELECT a.user_code AS "userCode", a.user_name AS "userName",
                a.assigned_at AS "from", a.removed_at AS "to",
                COALESCE((SELECT SUM(p.qty) FROM sort_slip_picks p
                           WHERE p.sort_slip_id = a.sort_slip_id
                             AND p.picked_by_code = a.user_code
                             AND NOT p.voided
                             AND p.picked_at >= a.assigned_at
                             AND (a.removed_at IS NULL OR p.picked_at < a.removed_at)), 0)::int AS "pickedQty"
           FROM sort_slip_assignees a
          WHERE a.sort_slip_id = $1
          ORDER BY a.assigned_at ASC`,
        [slip.id],
      ),
    ]);

    // Pallet size per item, resolved once for this slip's plant. 0 when Product Master has no
    // size for this state — the pick popup then asks for pieces only, rather than inventing a
    // pallet count from a number nobody set.
    const state = await getPlantStateCode(pool, slip.plant ?? '');
    const items = itemsRes.rows.map((row: any) => ({
      ...row,
      palletSize: getPalletSize({ gjPlt: row.gjPlt, mpPlt: row.mpPlt }, state),
    }));

    res.json({
      slip: {
        id: slip.id, orderNumber: slip.order_number, proformaSlipId: slip.proforma_slip_id,
        partyName: slip.party_name, plant: slip.plant, orderDate: slip.order_date_text,
        totalQty: slip.total_qty, status: slip.status, notes: slip.notes,
        platformStv: slip.platform_stv,
        createdByName: slip.created_by_name, createdAt: slip.created_at,
        activatedAt: slip.activated_at,
        completedAt: slip.completed_at, completedByName: slip.completed_by_name,
      },
      items,
      assignees: assigneeRes.rows,
      loaderTimeline: timelineRes.rows,
      canWrite: hasWrite(req),
      canPick: hasWrite(req) || mine,
    });
  } catch (error) {
    console.error('[Sort Slip] detail failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to load the sort slip' });
  }
});

// GET /sort-slips/:id/history — picks and transfers on one timeline.
router.get('/sort-slips/:id(\\d+)/history', requirePageAccess('sort-slip'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const slip = await getSlipById(id);
    if (!slip) return res.status(404).json({ message: 'Sort slip not found' });
    if (!hasWrite(req) && !(await isAssignee(id, actor(req).userCode))) {
      return res.status(403).json({ message: 'This sort slip is not assigned to you' });
    }

    const [picks, handoffs] = await Promise.all([
      pool.query(
        `SELECT id, proforma_slip_item_id AS "itemId", item_name AS "itemName", sr_no AS "srNo", barcode, qty,
                picked_by_code AS "pickedByCode", picked_by_name AS "pickedByName", picked_at AS "pickedAt",
                voided, voided_by_code AS "voidedByCode", voided_at AS "voidedAt"
           FROM sort_slip_picks WHERE sort_slip_id = $1 ORDER BY picked_at DESC, id DESC`,
        [id],
      ),
      pool.query(
        `SELECT id, from_user_name AS "fromUserName", to_user_name AS "toUserName",
                transferred_by_name AS "transferredByName", transferred_at AS "transferredAt", reason
           FROM sort_slip_handoffs WHERE sort_slip_id = $1 ORDER BY transferred_at DESC, id DESC`,
        [id],
      ),
    ]);
    res.json({ picks: picks.rows, handoffs: handoffs.rows });
  } catch (error) {
    console.error('[Sort Slip] history failed:', error);
    res.status(500).json({ message: 'Failed to load the history' });
  }
});

// ─── Supervisor actions (write access only) ──────────────────────────────────

// POST /sort-slips — turn a proforma order into a sort slip for ONE loader.
//
// The loader is required and the whole thing is all-or-nothing: if they cannot take it (busy on
// another slip, no page access, not this plant), no slip is created at all. A slip with nobody on
// it would sit in the list looking like work in progress that nobody is doing.
router.post('/sort-slips', requirePageWrite('sort-slip'), async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const orderNumber = String(req.body?.orderNumber ?? '').trim();
    const loaderCode = String(req.body?.loaderCode ?? '').trim();
    const notes = String(req.body?.notes ?? '').trim() || null;
    const requestedStv = String(req.body?.platformStv ?? '').trim();
    if (!orderNumber) return res.status(400).json({ message: 'An order number is required' });
    if (!loaderCode) return res.status(400).json({ message: 'Pick the loader who will sort this order' });
    if (!requestedStv) return res.status(400).json({ message: 'Select an STV/platform before creating this sort slip' });

    const { rows: orderRows } = await client.query(
      `SELECT ps.id, ps.order_number, ps.party_name, ps.plant, ps.order_date::text AS order_date,
              COALESCE((SELECT SUM(i.quantity) FROM proforma_slip_items i
                         WHERE i.proforma_slip_id = ps.id), 0)::int AS total_qty
         FROM proforma_slips ps WHERE ps.order_number = $1 ORDER BY ps.id DESC LIMIT 1`,
      [orderNumber],
    );
    const order = orderRows[0];
    if (!order) return res.status(404).json({ message: `No proforma slip found for order ${orderNumber}` });
    if (!canAccessPlant(req, order.plant)) {
      return res.status(403).json({ message: 'This order belongs to a plant you do not have access to' });
    }

    // The STV picked here must actually be one of the order's plant's configured STVs — checked
    // server-side, not just constrained by the dialog's own <Select>, same as Loading's Create
    // Operation guard (server/routes/loading.ts's plantStvList/matchedStv).
    const { rows: stvRows } = await client.query(
      `SELECT s.stv FROM plant_stvs s JOIN plants p ON p.id = s.plant_id WHERE LOWER(p.name) = LOWER($1)`,
      [order.plant ?? ''],
    );
    const allowedStvs: string[] = stvRows.map((r: any) => String(r.stv));
    if (allowedStvs.length === 0) {
      return res.status(400).json({ message: `No STV is configured for plant ${order.plant ?? '—'} — add one in Plant Settings first` });
    }
    const matchedStv = allowedStvs.find((s) => s.trim().toLowerCase() === requestedStv.toLowerCase());
    if (!matchedStv) {
      return res.status(400).json({ message: `"${requestedStv}" is not an STV configured for plant ${order.plant ?? '—'}` });
    }

    // Everything about the loader is checked BEFORE anything is written, so a refusal leaves no
    // half-made slip behind.
    const check = await loaderCheck(loaderCode);
    if (check === 'access') {
      return res.status(400).json({ message: 'That person has not been given the Sort Slip page — grant it on User Management first' });
    }
    if (check === 'supervisor') {
      return res.status(400).json({ message: 'That person has write access to Sort Slip — supervisors assign the work, they are not given it' });
    }
    if (!(await loaderCanAccessPlant(loaderCode, order.plant))) {
      return res.status(400).json({ message: `That loader has no access to ${order.plant ?? 'this plant'} — give them the plant on User Management first` });
    }
    const alreadyOn = await activeSlipOf(loaderCode);
    if (alreadyOn) {
      return res.status(409).json({ message: `That loader is already on sort slip ${alreadyOn.orderNumber} — finish or transfer that one first` });
    }

    const { userCode, userName } = actor(req);
    await client.query('BEGIN');

    const existing = await client.query(`SELECT id FROM sort_slips WHERE order_number = $1`, [orderNumber]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Order ${orderNumber} already has a sort slip` });
    }

    const inserted = await client.query(
      `INSERT INTO sort_slips (order_number, proforma_slip_id, party_name, plant, order_date,
                               total_qty, status, activated_at, created_by_code, created_by_name, notes, platform_stv)
       VALUES ($1, $2, $3, $4, $5::date, $6, 'active', NOW(), $7, $8, $9, $10) RETURNING id`,
      [orderNumber, order.id, order.party_name, order.plant, order.order_date,
       order.total_qty, userCode, userName, notes, matchedStv],
    );
    const slipId: number = inserted.rows[0].id;

    try {
      await addAssignee(client, slipId, loaderCode, userCode, userName);
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err?.constraint === ONE_ACTIVE_INDEX) {
        const on = await activeSlipOf(loaderCode);
        return res.status(409).json({
          message: `That loader was given sort slip ${on?.orderNumber ?? 'another order'} a moment ago — pick someone else`,
        });
      }
      throw err;
    }
    await client.query('COMMIT');

    res.status(201).json({ id: slipId, orderNumber });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Sort Slip] create failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to create the sort slip' });
  } finally {
    client.release();
  }
});

// Puts a loader on a slip — re-using a previously removed row rather than stacking duplicates,
// so the history of who was on this slip stays readable.
async function addAssignee(client: any, slipId: number, userCode: string, byCode: string, byName: string) {
  const { rows } = await client.query(
    `SELECT id, removed_at FROM sort_slip_assignees WHERE sort_slip_id = $1 AND user_code = $2 ORDER BY id DESC LIMIT 1`,
    [slipId, userCode],
  );
  const user = await client.query(`SELECT name, username FROM users WHERE user_code = $1`, [userCode]);
  const userName = user.rows[0]?.name || user.rows[0]?.username || userCode;

  if (rows[0] && rows[0].removed_at === null) return; // already on it
  if (rows[0]) {
    await client.query(
      `UPDATE sort_slip_assignees
          SET removed_at = NULL, removed_by_code = NULL, is_active = true,
              assigned_by_code = $2, assigned_by_name = $3, assigned_at = NOW()
        WHERE id = $1`,
      [rows[0].id, byCode, byName],
    );
    return;
  }
  await client.query(
    `INSERT INTO sort_slip_assignees (sort_slip_id, user_code, user_name, assigned_by_code, assigned_by_name, is_active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [slipId, userCode, userName, byCode, byName],
  );
}

// A slip always has exactly one loader, so there is no "add" and no "remove": it is given out at
// creation and only ever changes hands through a transfer below. Adding a second person would
// make "whose slip is this" unanswerable, and removing the only one would leave work in the list
// that nobody is doing.

// DELETE /sort-slips/:id — throw the whole sort slip away.
//
// Supervisors only, and only while it is still open: once a slip is completed it is the record of
// a finished sort and stays. Removing a completed one means reopening it first, which is itself a
// supervisor action and leaves its own trail. The picks, the assignee and the handoffs go with it
// (ON DELETE CASCADE), which is why the page names how much picked work is about to be lost.
router.delete('/sort-slips/:id(\\d+)', requirePageWrite('sort-slip'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const slip = await getSlipById(id);
    if (!slip) return res.status(404).json({ message: 'Sort slip not found' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Plant access required' });
    if (slip.status === 'completed') {
      return res.status(400).json({
        message: 'This sort slip is completed — reopen it first if it really has to be deleted',
      });
    }

    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(qty), 0)::int AS picked FROM sort_slip_picks
        WHERE sort_slip_id = $1 AND NOT voided`,
      [id],
    );
    await pool.query(`DELETE FROM sort_slips WHERE id = $1`, [id]);
    console.log(`[Sort Slip] ${actor(req).userName} deleted ${slip.order_number} (${rows[0]?.picked ?? 0} pcs picked)`);
    res.json({ deleted: true, orderNumber: slip.order_number, pickedQty: rows[0]?.picked ?? 0 });
  } catch (error) {
    console.error('[Sort Slip] delete failed:', error);
    res.status(500).json({ message: 'Failed to delete the sort slip' });
  }
});

// Matches every non-voided pick already made on the OLD slip against the TARGET order's own
// items — by barcode, falling back to Sr No when a pick has no barcode — and checks each match
// still fits within what the target order actually asks for (minus whatever it already has
// picked against it, if anything). Shared by the preview and the real replace below, so what the
// preview promises is exactly what happens: no separate "guess" logic to drift out of step.
async function matchPicksToTargetOrder(client: any, oldSlipId: number, targetOrderNumber: string) {
  const targetRows = await client.query(
    `SELECT ps.id, ps.order_number, ps.party_name, ps.plant, ps.order_date::text AS order_date,
            COALESCE((SELECT SUM(i.quantity) FROM proforma_slip_items i
                       WHERE i.proforma_slip_id = ps.id), 0)::int AS total_qty
       FROM proforma_slips ps WHERE ps.order_number = $1 ORDER BY ps.id DESC LIMIT 1`,
    [targetOrderNumber],
  );
  const targetOrder = targetRows.rows[0] ?? null;
  if (!targetOrder) return { targetOrder: null, matched: [] as any[], unmatched: [] as any[] };

  // The old slip's own picks, grouped by which item they were made against — several picks can
  // land on the same line, and they have to be matched and checked together, not one at a time.
  const grouped = await client.query(
    `SELECT p.proforma_slip_item_id AS item_id, MAX(p.item_name) AS item_name, MAX(p.barcode) AS barcode,
            MAX(p.sr_no) AS sr_no, SUM(p.qty)::int AS qty
       FROM sort_slip_picks p
      WHERE p.sort_slip_id = $1 AND NOT p.voided
      GROUP BY p.proforma_slip_item_id`,
    [oldSlipId],
  );

  const targetItems = await client.query(
    `SELECT i.id, i.sr_no, i.barcode, i.item_name, COALESCE(i.quantity, 0)::int AS expected_qty,
            COALESCE((SELECT SUM(p.qty) FROM sort_slip_picks p
                       WHERE p.proforma_slip_item_id = i.id AND NOT p.voided), 0)::int AS already_picked
       FROM proforma_slip_items i WHERE i.proforma_slip_id = $1`,
    [targetOrder.id],
  );
  const byBarcode = new Map<string, any>();
  const bySrNo = new Map<string, any>();
  for (const item of targetItems.rows) {
    if (item.barcode) byBarcode.set(String(item.barcode).trim().toLowerCase(), item);
    if (item.sr_no) bySrNo.set(String(item.sr_no).trim().toLowerCase(), item);
  }

  const matched: any[] = [];
  const unmatched: any[] = [];
  for (const row of grouped.rows) {
    const barcodeKey = row.barcode ? String(row.barcode).trim().toLowerCase() : '';
    const srKey = row.sr_no ? String(row.sr_no).trim().toLowerCase() : '';
    const target = (barcodeKey && byBarcode.get(barcodeKey)) || (srKey && bySrNo.get(srKey));
    if (!target) {
      unmatched.push({
        oldItemId: row.item_id, oldItemName: row.item_name, barcode: row.barcode, qty: row.qty,
        reason: 'No matching item on the target order',
      });
      continue;
    }
    const available = target.expected_qty - target.already_picked;
    if (row.qty > available) {
      unmatched.push({
        oldItemId: row.item_id, oldItemName: row.item_name, barcode: row.barcode, qty: row.qty,
        reason: `Exceeds the target order's remaining quantity (${available} available, ${row.qty} needed)`,
      });
      continue;
    }
    matched.push({
      oldItemId: row.item_id, oldItemName: row.item_name, barcode: row.barcode, qty: row.qty,
      newItemId: target.id, newItemName: target.item_name, newSrNo: target.sr_no, newBarcode: target.barcode,
      newExpectedQty: target.expected_qty, alreadyPickedOnTarget: target.already_picked,
    });
  }
  return { targetOrder, matched, unmatched };
}

// GET /sort-slips/:id/replace-preview?targetOrderNumber=X — "would this work?", before anyone
// commits to it. Read-only: runs the exact same matching function the real replace does.
router.get('/sort-slips/:id(\\d+)/replace-preview', requirePageWrite('sort-slip'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const targetOrderNumber = String(req.query.targetOrderNumber ?? '').trim();
    if (!targetOrderNumber) return res.status(400).json({ message: 'Pick the order to replace with' });

    const slip = await getSlipById(id);
    if (!slip) return res.status(404).json({ message: 'Sort slip not found' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Plant access required' });
    if (targetOrderNumber === slip.order_number) return res.status(400).json({ message: 'That is the same order' });

    const existingTarget = await pool.query(`SELECT id FROM sort_slips WHERE order_number = $1`, [targetOrderNumber]);
    if (existingTarget.rows.length > 0) {
      return res.status(409).json({ message: `Order ${targetOrderNumber} already has a sort slip` });
    }

    const { targetOrder, matched, unmatched } = await matchPicksToTargetOrder(pool, id, targetOrderNumber);
    if (!targetOrder) return res.status(404).json({ message: `No proforma slip found for order ${targetOrderNumber}` });
    if (!canAccessPlant(req, targetOrder.plant)) {
      return res.status(403).json({ message: 'The target order belongs to a plant you do not have access to' });
    }

    res.json({
      targetOrder: {
        orderNumber: targetOrder.order_number, partyName: targetOrder.party_name,
        plant: targetOrder.plant, orderDate: targetOrder.order_date, totalQty: targetOrder.total_qty,
      },
      matched, unmatched,
      // Nothing to move is not a valid replace either — that is just a delete.
      canReplace: unmatched.length === 0 && matched.length > 0,
    });
  } catch (error) {
    console.error('[Sort Slip] replace preview failed:', error);
    res.status(500).json({ message: 'Failed to preview the replace' });
  }
});

// POST /sort-slips/:id/replace — body: { targetOrderNumber }.
//
// Instead of deleting the picked work along with a wrong slip, this moves every pick already
// made onto a brand-new slip for the CORRECT order, re-pointed at that order's own matching item
// (never left aimed at an item that belongs to someone else's order), then removes the old slip.
// All-or-nothing: re-runs the SAME matching the preview showed, inside the transaction, and
// refuses the whole thing if even one picked item has no home on the target order — never a
// partial move that quietly drops some of the work.
router.post('/sort-slips/:id(\\d+)/replace', requirePageWrite('sort-slip'), async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const targetOrderNumber = String(req.body?.targetOrderNumber ?? '').trim();
    if (!targetOrderNumber) return res.status(400).json({ message: 'Pick the order to replace with' });

    await client.query('BEGIN');
    const slipRes = await client.query(`SELECT * FROM sort_slips WHERE id = $1 FOR UPDATE`, [id]);
    const slip = slipRes.rows[0];
    if (!slip) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Sort slip not found' }); }
    if (!canAccessPlant(req, slip.plant)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Plant access required' });
    }
    if (slip.status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This sort slip is completed — reopen it first if it really has to be replaced' });
    }
    if (targetOrderNumber === slip.order_number) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'That is the same order' });
    }

    const existingTarget = await client.query(`SELECT id FROM sort_slips WHERE order_number = $1`, [targetOrderNumber]);
    if (existingTarget.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Order ${targetOrderNumber} already has a sort slip` });
    }

    const { targetOrder, matched, unmatched } = await matchPicksToTargetOrder(client, id, targetOrderNumber);
    if (!targetOrder) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: `No proforma slip found for order ${targetOrderNumber}` });
    }
    if (!canAccessPlant(req, targetOrder.plant)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'The target order belongs to a plant you do not have access to' });
    }
    if (unmatched.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `${unmatched.length} picked item(s) have no home on that order — void them first, or pick a different order`,
        unmatched,
      });
    }
    if (matched.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Nothing has been picked on this slip yet — delete it and start a fresh one instead' });
    }

    // Whoever currently holds the old slip comes with it, off the old one first so the
    // one-active-slip index never has to consider them on two slips even for an instant.
    const loaderRow = await client.query(
      `SELECT user_code FROM sort_slip_assignees WHERE sort_slip_id = $1 AND removed_at IS NULL ORDER BY assigned_at DESC LIMIT 1`,
      [id],
    );
    const loaderCode: string | null = loaderRow.rows[0]?.user_code ?? null;
    const { userCode, userName } = actor(req);

    const inserted = await client.query(
      `INSERT INTO sort_slips (order_number, proforma_slip_id, party_name, plant, order_date,
                               total_qty, status, activated_at, created_by_code, created_by_name, notes)
       VALUES ($1, $2, $3, $4, $5::date, $6, 'active', NOW(), $7, $8, $9) RETURNING id`,
      [targetOrderNumber, targetOrder.id, targetOrder.party_name, targetOrder.plant, targetOrder.order_date,
       targetOrder.total_qty, userCode, userName, `Replaced from order ${slip.order_number} (sort slip #${id})`],
    );
    const newSlipId: number = inserted.rows[0].id;

    if (loaderCode) {
      await client.query(
        `UPDATE sort_slip_assignees SET removed_at = NOW(), removed_by_code = $2, is_active = false
          WHERE sort_slip_id = $1 AND removed_at IS NULL`,
        [id, userCode],
      );
      await addAssignee(client, newSlipId, loaderCode, userCode, userName);
    }

    // Every matched pick moves onto the new slip, re-pointed at the target order's own item —
    // its snapshot fields re-taken from THAT item, not left carrying the old order's labels.
    for (const m of matched) {
      await client.query(
        `UPDATE sort_slip_picks
            SET sort_slip_id = $1, order_number = $2, proforma_slip_item_id = $3,
                barcode = $4, sr_no = $5, item_name = $6
          WHERE sort_slip_id = $7 AND proforma_slip_item_id = $8 AND NOT voided`,
        [newSlipId, targetOrderNumber, m.newItemId, m.newBarcode, m.newSrNo, m.newItemName, id, m.oldItemId],
      );
    }

    // Whatever is left on the old slip now — only voided picks, if any — goes with it.
    await client.query(`DELETE FROM sort_slips WHERE id = $1`, [id]);
    await client.query('COMMIT');

    const movedQty = matched.reduce((sum: number, m: any) => sum + m.qty, 0);
    console.log(`[Sort Slip] ${userName} replaced ${slip.order_number} with ${targetOrderNumber} (slip #${id} -> #${newSlipId}, ${movedQty} pcs moved)`);
    res.json({ replaced: true, oldOrderNumber: slip.order_number, newSlipId, newOrderNumber: targetOrderNumber, movedQty });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Sort Slip] replace failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to replace the sort slip' });
  } finally {
    client.release();
  }
});

// POST /sort-slips/:id/transfer — hand the slip from one loader to another.
// Write access only, by design: a loader can never move their own work onto somebody else.
router.post('/sort-slips/:id(\\d+)/transfer', requirePageWrite('sort-slip'), async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const toUserCode = String(req.body?.toUserCode ?? '').trim();
    const reason = String(req.body?.reason ?? '').trim() || null;
    if (!toUserCode) return res.status(400).json({ message: 'Pick the loader to hand it to' });

    const slip = await getSlipById(id);
    if (!slip) return res.status(404).json({ message: 'Sort slip not found' });
    if (slip.status === 'completed') return res.status(400).json({ message: 'This sort slip is completed' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Plant access required' });

    // Whoever currently holds it — the caller does not have to say, because there is only ever
    // one. Null when the slip came back from a reopen with its loader already busy elsewhere,
    // and a transfer is then how it gets someone again.
    const from = await pool.query(
      `SELECT user_code, user_name FROM sort_slip_assignees
        WHERE sort_slip_id = $1 AND removed_at IS NULL ORDER BY assigned_at DESC LIMIT 1`,
      [id],
    );
    const fromUserCode: string | null = from.rows[0]?.user_code ?? null;
    if (fromUserCode === toUserCode) {
      return res.status(400).json({ message: 'That loader already has this sort slip' });
    }

    const { userCode, userName } = actor(req);
    await client.query('BEGIN');
    // Off first, then on: doing it the other way round would trip the one-active-slip index when
    // the incoming loader is being moved between two slips in quick succession.
    await client.query(
      `UPDATE sort_slip_assignees SET removed_at = NOW(), removed_by_code = $2, is_active = false
        WHERE sort_slip_id = $1 AND removed_at IS NULL`,
      [id, userCode],
    );
    const toCheck = await loaderCheck(toUserCode);
    if (toCheck !== 'ok') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: toCheck === 'supervisor'
          ? 'That person has write access to Sort Slip — supervisors assign the work, they are not given it'
          : 'That person has not been given the Sort Slip page — grant it on User Management first',
      });
    }
    if (!(await loaderCanAccessPlant(toUserCode, slip.plant))) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: `That loader has no access to ${slip.plant ?? 'this plant'} — give them the plant on User Management first`,
      });
    }
    try {
      await addAssignee(client, id, toUserCode, userCode, userName);
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err?.constraint === ONE_ACTIVE_INDEX) {
        const on = await activeSlipOf(toUserCode);
        return res.status(409).json({
          message: `That loader is already on sort slip ${on?.orderNumber ?? 'another order'} — finish or free that one first`,
        });
      }
      throw err;
    }
    const to = await client.query(`SELECT name, username FROM users WHERE user_code = $1`, [toUserCode]);
    await client.query(
      `INSERT INTO sort_slip_handoffs (sort_slip_id, order_number, from_user_code, from_user_name,
                                       to_user_code, to_user_name, transferred_by_code, transferred_by_name, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, slip.order_number, fromUserCode, from.rows[0]?.user_name ?? fromUserCode, toUserCode,
       to.rows[0]?.name || to.rows[0]?.username || toUserCode, userCode, userName, reason],
    );
    // A slip that came out of a reopen with nobody on it is working again the moment it has one.
    await client.query(
      `UPDATE sort_slips SET status = 'active', activated_at = COALESCE(activated_at, NOW()) WHERE id = $1`,
      [id],
    );
    await client.query('COMMIT');
    res.json({ transferred: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Sort Slip] transfer failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to transfer' });
  } finally {
    client.release();
  }
});

// POST /sort-slips/:id/complete — the supervisor closes it.
// A slip never completes itself, even when every line is fully picked: closing it is a decision,
// and it is what frees its loaders for their next slip. Short slips can be closed too — the page
// shows the shortfall first.
router.post('/sort-slips/:id(\\d+)/complete', requirePageWrite('sort-slip'), async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const slip = await getSlipById(id);
    if (!slip) return res.status(404).json({ message: 'Sort slip not found' });
    if (slip.status === 'completed') return res.status(400).json({ message: 'This sort slip is already completed' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Plant access required' });

    const { userCode, userName } = actor(req);
    await client.query('BEGIN');
    await client.query(
      `UPDATE sort_slips SET status = 'completed', completed_at = NOW(),
                             completed_by_code = $2, completed_by_name = $3 WHERE id = $1`,
      [id, userCode, userName],
    );
    await client.query(`UPDATE sort_slip_assignees SET is_active = false WHERE sort_slip_id = $1`, [id]);
    await client.query('COMMIT');
    res.json({ completed: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Sort Slip] complete failed:', error);
    res.status(500).json({ message: 'Failed to complete the sort slip' });
  } finally {
    client.release();
  }
});

// POST /sort-slips/:id/reopen — put a completed slip back to work.
// Its loaders are only made active again if they are still free: someone may have been given
// another slip in the meantime, and the one-active-slip rule still holds.
router.post('/sort-slips/:id(\\d+)/reopen', requirePageWrite('sort-slip'), async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const slip = await getSlipById(id);
    if (!slip) return res.status(404).json({ message: 'Sort slip not found' });
    if (slip.status !== 'completed') return res.status(400).json({ message: 'This sort slip is not completed' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Plant access required' });

    // The loader it was completed with gets it back — but only if they are still free, since the
    // one-active-slip rule did not pause while this slip was closed. If they are not, the slip
    // comes back with nobody on it and the supervisor hands it to someone with a transfer.
    const { rows: people } = await pool.query(
      `SELECT user_code, user_name FROM sort_slip_assignees
        WHERE sort_slip_id = $1 AND removed_at IS NULL ORDER BY assigned_at DESC LIMIT 1`,
      [id],
    );
    const loader = people[0];
    let busyLoader: string | null = null;
    await client.query('BEGIN');
    if (loader) {
      try {
        await client.query('SAVEPOINT reactivate');
        await client.query(
          `UPDATE sort_slip_assignees SET is_active = true WHERE sort_slip_id = $1 AND user_code = $2`,
          [id, loader.user_code],
        );
        await client.query('RELEASE SAVEPOINT reactivate');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT reactivate');
        if (err?.constraint === ONE_ACTIVE_INDEX) busyLoader = loader.user_name ?? loader.user_code;
        else throw err;
      }
    }
    await client.query(
      `UPDATE sort_slips SET status = $2, completed_at = NULL, completed_by_code = NULL, completed_by_name = NULL
        WHERE id = $1`,
      [id, loader && !busyLoader ? 'active' : 'unassigned'],
    );
    await client.query('COMMIT');
    res.json({ reopened: true, busyLoader });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Sort Slip] reopen failed:', error);
    res.status(500).json({ message: 'Failed to reopen the sort slip' });
  } finally {
    client.release();
  }
});

// ─── Picking (a loader's one write) ──────────────────────────────────────────

// Lets a request through if it holds write access, or if it holds view access AND the slip it
// names is assigned to the caller. Everything else about the page stays write-gated.
function requirePickAccess(req: Request, res: Response, next: NextFunction) {
  requirePageAccess('sort-slip')(req, res, () => {
    if (hasWrite(req)) return next();
    const id = parseInt(req.params.id ?? '', 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Sort slip id is required' });
    isAssignee(id, actor(req).userCode)
      .then((ok) => ok
        ? next()
        : res.status(403).json({ message: 'This sort slip is not assigned to you' }))
      .catch(() => res.status(500).json({ message: 'Could not check the assignment' }));
  });
}

// POST /sort-slips/:id/pick — "I have taken this much of this item".
//
// The over-pick rule (a pick may never take a line past what the order asks for) is checked
// INSIDE a transaction that locks the slip row first. Several loaders work one slip at once, so
// two of them can tap Confirm on the same item in the same second: without the lock both would
// read the same "20 remaining" and both would be allowed, putting 40 against an expected 20.
router.post('/sort-slips/:id(\\d+)/pick', requirePickAccess, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const itemId = parseInt(String(req.body?.itemId ?? ''), 10);
    const qty = parseInt(String(req.body?.qty ?? ''), 10);
    if (!Number.isFinite(itemId)) return res.status(400).json({ message: 'Pick an item first' });
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ message: 'Enter a quantity greater than zero' });

    await client.query('BEGIN');
    const slipRes = await client.query(`SELECT * FROM sort_slips WHERE id = $1 FOR UPDATE`, [id]);
    const slip = slipRes.rows[0];
    if (!slip) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Sort slip not found' }); }
    if (slip.status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This sort slip is completed — ask a supervisor to reopen it' });
    }
    if (!canAccessPlant(req, slip.plant)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Plant access required' });
    }

    const itemRes = await client.query(
      `SELECT i.id, i.sr_no, i.barcode, i.item_name, COALESCE(i.quantity, 0)::int AS expected
         FROM proforma_slip_items i WHERE i.id = $1 AND i.proforma_slip_id = $2`,
      [itemId, slip.proforma_slip_id],
    );
    const item = itemRes.rows[0];
    if (!item) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'That item is not on this order' }); }

    const pickedRes = await client.query(
      `SELECT COALESCE(SUM(qty), 0)::int AS picked FROM sort_slip_picks
        WHERE proforma_slip_item_id = $1 AND NOT voided`,
      [itemId],
    );
    const picked: number = pickedRes.rows[0]?.picked ?? 0;
    const remaining = item.expected - picked;
    if (qty > remaining) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: remaining <= 0
          ? `${item.item_name ?? 'This item'} is already fully picked`
          : `Only ${remaining} left on ${item.item_name ?? 'this item'} — someone may have picked it while this was open`,
        remaining,
      });
    }

    const { userCode, userName } = actor(req);
    const inserted = await client.query(
      `INSERT INTO sort_slip_picks (sort_slip_id, order_number, proforma_slip_item_id, barcode, sr_no,
                                    item_name, qty, picked_by_code, picked_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, picked_at AS "pickedAt"`,
      [id, slip.order_number, itemId, item.barcode, item.sr_no, item.item_name, qty, userCode, userName],
    );
    await client.query('COMMIT');

    res.json({
      pickId: inserted.rows[0].id,
      itemId,
      pickedQty: picked + qty,
      expectedQty: item.expected,
      remaining: remaining - qty,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Sort Slip] pick failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to record the pick' });
  } finally {
    client.release();
  }
});

// POST /sort-slips/picks/:pickId/void — undo a pick.
// Your own is yours to undo; anyone else's needs write access. Voided rather than deleted, so
// "60 picked, then 20 taken back" stays visible instead of looking like it never happened.
router.post('/sort-slips/picks/:pickId(\\d+)/void', requirePageAccess('sort-slip'), async (req: Request, res: Response) => {
  try {
    const pickId = parseInt(req.params.pickId, 10);
    const { rows } = await pool.query(`SELECT * FROM sort_slip_picks WHERE id = $1`, [pickId]);
    const pick = rows[0];
    if (!pick) return res.status(404).json({ message: 'That entry no longer exists' });
    if (pick.voided) return res.status(400).json({ message: 'That entry is already voided' });

    const { userCode } = actor(req);
    if (!hasWrite(req) && pick.picked_by_code !== userCode) {
      return res.status(403).json({ message: 'You can only remove your own entries' });
    }
    const slip = await getSlipById(pick.sort_slip_id);
    if (slip?.status === 'completed' && !hasWrite(req)) {
      return res.status(400).json({ message: 'This sort slip is completed' });
    }

    await pool.query(
      `UPDATE sort_slip_picks SET voided = true, voided_by_code = $2, voided_at = NOW() WHERE id = $1`,
      [pickId, userCode],
    );
    res.json({ voided: true, itemId: pick.proforma_slip_item_id });
  } catch (error) {
    console.error('[Sort Slip] void failed:', error);
    res.status(500).json({ message: 'Failed to remove the entry' });
  }
});

export default router;
