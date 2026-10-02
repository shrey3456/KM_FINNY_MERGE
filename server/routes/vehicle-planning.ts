import { Router, Request, Response } from 'express';
import { Client } from '@notionhq/client';
import { storage } from '../storage';
import { pool } from '../db';
import { requirePageAccess, requirePageWrite } from '../lib/pageAccess';
import { qualifiesForLoadingVehiclePicker } from './loading';

// Vehicle Planning — a Gantt-style "when is each vehicle free" view over Krupa's own fleet
// (same company filter as Loading's vehicle picker: company contains "krupa" or "dummy"), so a
// planner can see which vehicle to assign a pending order to.
//
// TEST MODE — remove once this page is trusted: every WRITE here (assign) is restricted to
// these three dummy order numbers only, so a bug in this brand-new page can't touch a real
// order. Read-only display (the Gantt itself) is NOT restricted to these — it shows the real
// fleet. Delete TEST_MODE_ORDER_NUMBERS and the one check that reads it to lift the restriction.
const TEST_MODE_ORDER_NUMBERS = ['1111111111', '2222222222', '3333333333'];

const router = Router();

const notion = new Client({ auth: process.env.NOTION_INTEGRATION_SECRET });
const ORDER_DATABASE_ID = (process.env.ORDER_DATABASE_ID ?? '').trim() || undefined;

// A vehicle counts as "busy" while its most recent order's status isn't one of these terminal
// ones — approximate (local notion_status can lag a live sync), good enough for a first pass.
const TERMINAL_STATUSES = new Set(['DISPATCHED', 'DELIVERED', 'CANCELLED', 'READY≈DESP']);

// "Trip Complets on" prints as "DD/MM/YYYY" (confirmed live against the database) — not ISO.
function parseDmyDate(raw: string | null): Date | null {
  if (!raw) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

function todayMidnightUTC(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// Generic-ish Notion property value reader covering every property type this file touches,
// including a "show_original" rollup (State :, which wraps Party State : — unwrap its array and
// recurse on the first item's own type) and a formula of unknown result type (Party Name :).
function extractPropertyValue(prop: any): string | null {
  if (!prop) return null;
  switch (prop.type) {
    case 'rich_text': return prop.rich_text.map((t: any) => t.plain_text).join('') || null;
    case 'title': return prop.title.map((t: any) => t.plain_text).join('') || null;
    case 'status': return prop.status?.name ?? null;
    case 'select': return prop.select?.name ?? null;
    case 'date': return prop.date?.start ?? null;
    case 'formula':
      if (prop.formula?.type === 'string') return prop.formula.string ?? null;
      if (prop.formula?.type === 'number') return prop.formula.number != null ? String(prop.formula.number) : null;
      if (prop.formula?.type === 'boolean') return prop.formula.boolean != null ? String(prop.formula.boolean) : null;
      if (prop.formula?.type === 'date') return prop.formula.date?.start ?? null;
      return null;
    case 'rollup':
      if (prop.rollup?.type === 'array' && prop.rollup.array.length > 0) return extractPropertyValue(prop.rollup.array[0]);
      if (prop.rollup?.type === 'number') return prop.rollup.number != null ? String(prop.rollup.number) : null;
      return null;
    default: return null;
  }
}

type LiveOrder = {
  orderNumber: string; orderDate: string | null; partyName: string | null; partyState: string | null;
  plant: string | null; driver: string | null;
  status: string | null; tripCompletesOn: string | null; tripDays: string | null;
};

// Each qualifying vehicle's CURRENT order, found entirely live from Notion via the order
// database's "Vehi  No. :" relation — explicit request: proforma_slips isn't reliably synced,
// so it must never be consulted to decide which order is "current," not even as a starting
// point. Batched in chunks of relation-contains filters (same rate-limit reasoning as the old
// per-order-number fetch) rather than one query per vehicle; each returned page can match
// several of the batch's vehicles (a relation can hold more than one), so pages are bucketed by
// vehicle notionPageId and only the latest (by "Ord Date :") is kept per vehicle.
async function fetchCurrentOrdersByVehicle(vehicleNotionPageIds: string[]): Promise<Map<string, LiveOrder>> {
  const latestByVehicle = new Map<string, LiveOrder>();
  if (!ORDER_DATABASE_ID || vehicleNotionPageIds.length === 0) return latestByVehicle;

  const CHUNK_SIZE = 50; // comfortably under Notion's own filter-count limits
  const chunks: string[][] = [];
  for (let i = 0; i < vehicleNotionPageIds.length; i += CHUNK_SIZE) chunks.push(vehicleNotionPageIds.slice(i, i + CHUNK_SIZE));

  // A single rarely-used vehicle in a 50-vehicle chunk (last order months ago) used to force
  // that whole chunk to keep paging — sorted-descending across ALL 50 vehicles combined, so the
  // loop can't exit until even the straggler's old order is reached, however many pages of every
  // OTHER vehicle's more recent orders that takes. Bounding to a recent window fixes that: a
  // vehicle with nothing in the last 45 days is just reported as having no current order (which
  // is also the right answer — it's obviously free), instead of hunting arbitrarily far back.
  const recentCutoff = new Date();
  recentCutoff.setDate(recentCutoff.getDate() - 45);
  const recentCutoffIso = recentCutoff.toISOString().slice(0, 10);

  await Promise.all(chunks.map(async (chunk) => {
    try {
      const remaining = new Set(chunk);
      let cursor: string | undefined;
      do {
        const resp: any = await notion.databases.query({
          database_id: ORDER_DATABASE_ID,
          filter: {
            and: [
              { or: chunk.map((id) => ({ property: 'Vehi  No. :', relation: { contains: id } })) },
              { property: 'Ord Date :', date: { on_or_after: recentCutoffIso } },
            ],
          },
          // Newest first — a vehicle can have a long order history, and without this the first
          // match for each vehicle isn't necessarily its latest one, so "which order is
          // current" could resolve to a months-old order if it happened to come back first.
          // Combined with the early-exit below, this also means fetching stops almost
          // immediately once every vehicle in this batch already has an answer, instead of
          // paging through that entire history regardless.
          sorts: [{ property: 'Ord Date :', direction: 'descending' }],
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        for (const page of resp.results) {
          const relatedVehicleIds: string[] = (page.properties['Vehi  No. :']?.relation ?? []).map((r: any) => r.id);
          const orderNumber = extractPropertyValue(page.properties['Order No. :']);
          if (!orderNumber) continue;
          const order: LiveOrder = {
            orderNumber, orderDate: extractPropertyValue(page.properties['Ord Date :']),
            partyName: extractPropertyValue(page.properties['Party Name :']),
            partyState: extractPropertyValue(page.properties['State :']),
            // Confirmed live against this database (same way "Trip Complets on" above was) —
            // a `select`, not text; the plant this order is loading FROM, not the party's own
            // state (which is what 'State :' above actually is, despite the name).
            plant: extractPropertyValue(page.properties['Stk Plant :']),
            // Vehicle Master's own `driver` field is empty for the whole Krupa fleet — the real
            // driver turns out to be recorded per TRIP (order), not per vehicle. "Driver :" itself
            // is a relation; "Link to Driver :" is a formula that already resolves it to the
            // plain name, confirmed live the same way.
            driver: extractPropertyValue(page.properties['Link to Driver :']),
            status: extractPropertyValue(page.properties['Finny Status :']),
            tripCompletesOn: extractPropertyValue(page.properties['Trip Complets on']),
            tripDays: extractPropertyValue(page.properties['Party Trips (Days)']),
          };
          for (const vehicleId of relatedVehicleIds) {
            // Only the FIRST (= newest, thanks to the sort) match per vehicle is kept — a later
            // match in descending order is by definition older, so it's never an update.
            if (!remaining.has(vehicleId)) continue;
            latestByVehicle.set(vehicleId, order);
            remaining.delete(vehicleId);
          }
        }
        cursor = remaining.size > 0 && resp.has_more ? resp.next_cursor ?? undefined : undefined;
      } while (cursor);
    } catch (err) {
      console.error('[Vehicle Planning] Live Notion lookup failed for a batch of vehicles:', err);
    }
  }));

  return latestByVehicle;
}

// Short-lived cache for the whole fleet view — the live Notion lookup above is what actually
// takes time (multiple batched, paginated requests), and this page gets reloaded/refetched far
// more often than the underlying data actually changes within a few tens of seconds. Not
// per-user (the data isn't user-specific), so every viewer shares one cache. Still "live from
// Notion" in the sense that matters — a cache this short is never the reason someone sees a
// truly stale assignment — just not re-fetched on literally every single render.
const FLEET_CACHE_TTL_MS = 30_000;
let fleetCache: { at: number; body: any } | null = null;

// GET /api/vehicle-planning/vehicles — one row per qualifying vehicle, with its most recent
// order (if any) and a best-effort busy/free read.
router.get('/vehicle-planning/vehicles', requirePageAccess('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    if (fleetCache && Date.now() - fleetCache.at < FLEET_CACHE_TTL_MS) {
      return res.json(fleetCache.body);
    }

    const all = await storage.getAllVehicleInfo();
    const fleet = all.filter((v) => qualifiesForLoadingVehiclePicker(v.company));

    // Entirely live from Notion — proforma_slips is not reliably synced, so it is never
    // consulted here, not even as a starting point for "which order is current".
    const vehiclesWithNotionId = fleet.filter((v): v is typeof v & { notionPageId: string } => !!v.notionPageId);
    const currentOrderByVehicle = await fetchCurrentOrdersByVehicle(vehiclesWithNotionId.map((v) => v.notionPageId));

    // Plant -> state (Plant Master's own short code, e.g. "GJ") — the State column shows THIS,
    // for the order's plant, never the order's party/destination state (that's a different field
    // Notion happens to also call "State :"). Looked up fresh each request; Plant Master is tiny
    // and rarely changes, so no caching needed beyond the fleet response's own 30s cache.
    const allPlants = await storage.getAllPlants();
    const stateByPlant = new Map(allPlants.map((p) => [p.name.trim().toLowerCase(), p.state] as const));

    const rows = fleet.map((v) => {
      const currentOrder = v.notionPageId ? currentOrderByVehicle.get(v.notionPageId) ?? null : null;
      if (!v.vehicleNumber || !currentOrder) {
        return {
          id: v.id, vehicleNumber: v.vehicleNumber ?? null, rtoNumber: v.rtoNumber, driver: v.driver,
          state: null, company: v.company, currentOrder: null, busy: false, busyUntil: null, tripDays: null,
        };
      }
      const status = String(currentOrder.status ?? '').toUpperCase();
      const tripEndDate = parseDmyDate(currentOrder.tripCompletesOn);
      // A vehicle is free once EITHER the status is explicitly terminal OR its calculated trip
      // end date has already passed — the date check matters because a dispatcher doesn't
      // always flip the Notion status field the moment a trip actually finishes, which was
      // leaving a vehicle stuck showing "busy" forever past its own calculated free date.
      const tripHasEnded = !!tripEndDate && tripEndDate < todayMidnightUTC();
      const busy = !TERMINAL_STATUSES.has(status) && !tripHasEnded;
      const busyUntil = busy ? currentOrder.tripCompletesOn : null;
      const plantState = currentOrder.plant ? stateByPlant.get(currentOrder.plant.trim().toLowerCase()) ?? null : null;

      return {
        id: v.id, vehicleNumber: v.vehicleNumber, rtoNumber: v.rtoNumber,
        // Vehicle Master's own driver field is empty for this whole fleet — the real driver is
        // recorded per TRIP in Notion (currentOrder.driver), not per vehicle. Vehicle Master's
        // value is kept as a fallback only, for a vehicle whose Notion driver field is blank.
        driver: currentOrder.driver ?? v.driver,
        // Plant Master's state for THIS order's plant — follows whichever order is current, so
        // it changes on its own the day a vehicle moves from a Valsad order to an Indore one.
        state: plantState, company: v.company,
        currentOrder: {
          orderNumber: currentOrder.orderNumber, partyName: currentOrder.partyName,
          plant: currentOrder.plant, orderDate: currentOrder.orderDate, notionStatus: currentOrder.status,
        },
        busy, busyUntil, tripDays: currentOrder.tripDays,
      };
    });

    const body = { vehicles: rows, testModeOrderNumbers: TEST_MODE_ORDER_NUMBERS };
    fleetCache = { at: Date.now(), body };
    res.json(body);
  } catch (error) {
    console.error('Error building vehicle planning fleet view:', error);
    res.status(500).json({ message: 'Failed to load vehicle planning data' });
  }
});

// GET /api/vehicle-planning/available-orders — TEST MODE: only ever these three dummy orders,
// straight from the local DB (whatever's already there right now).
router.get('/vehicle-planning/available-orders', requirePageAccess('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT order_number AS "orderNumber", party_name AS "partyName", plant,
              order_date::text AS "orderDate", vehicle_number AS "vehicleNumber",
              notion_status AS "notionStatus"
       FROM proforma_slips
       WHERE order_number = ANY($1)
       ORDER BY order_number`,
      [TEST_MODE_ORDER_NUMBERS],
    );
    res.json({ orders: rows });
  } catch (error) {
    console.error('Error listing available orders for vehicle planning:', error);
    res.status(500).json({ message: 'Failed to load available orders' });
  }
});

// POST /api/vehicle-planning/assign — body: { orderNumber, vehicleId }. TEST MODE: orderNumber
// must be one of TEST_MODE_ORDER_NUMBERS, checked before anything else happens.
router.post('/vehicle-planning/assign', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const orderNumber = String(req.body?.orderNumber ?? '').trim();
    const vehicleId = req.body?.vehicleId != null ? Number(req.body.vehicleId) : null;
    if (!orderNumber || !vehicleId) return res.status(400).json({ message: 'orderNumber and vehicleId are required' });

    if (!TEST_MODE_ORDER_NUMBERS.includes(orderNumber)) {
      return res.status(403).json({
        message: `Vehicle Planning is in test mode — only orders ${TEST_MODE_ORDER_NUMBERS.join(', ')} can be assigned right now.`,
      });
    }

    const slip = await storage.getProformaSlipByOrderNumber(orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    const vehicle = await storage.getVehicleInfo(vehicleId);
    if (!vehicle) return res.status(404).json({ message: 'Vehicle not found' });
    if (!vehicle.vehicleNumber) return res.status(400).json({ message: 'This vehicle has no vehicle number set in Vehicle Master.' });

    const { userCode } = (() => {
      const u = req.user as any;
      return { userCode: u?.userCode as string | undefined };
    })();

    const updated = await storage.updateProformaSlip(slip.id, {
      vehicleNumber: vehicle.vehicleNumber,
      vehicleInfoId: vehicle.id,
      vehicleAssignedByCode: userCode ?? null,
    } as any);
    if (!updated) return res.status(500).json({ message: 'Failed to assign vehicle' });

    // Mirror to Notion — "Vehi  No. :" on the Order database is a RELATION (to the vehicle's
    // own Notion page), not a text field, so this sets a relation rather than pushing a string
    // the way the STV/StoreKeeper pushes elsewhere do. Best-effort: the local assignment above
    // already succeeded and is the source of truth; a Notion hiccup here is logged, not thrown.
    if (vehicle.notionPageId && ORDER_DATABASE_ID) {
      try {
        const resp = await notion.databases.query({
          database_id: ORDER_DATABASE_ID,
          filter: { property: 'Order No. :', rich_text: { contains: orderNumber } },
          page_size: 1,
        });
        const page: any = resp.results[0];
        if (page) {
          await notion.pages.update({
            page_id: page.id,
            properties: { 'Vehi  No. :': { relation: [{ id: vehicle.notionPageId }] } } as any,
          });
        } else {
          console.warn(`[Vehicle Planning] No Order DB page found for order ${orderNumber} — local assignment saved, Notion not updated`);
        }
      } catch (notionError) {
        console.error(`[Vehicle Planning] Failed to push vehicle assignment to Notion for order ${orderNumber}:`, notionError);
      }
    }

    // Bust the fleet cache — otherwise this exact vehicle could keep showing as free for up to
    // FLEET_CACHE_TTL_MS more, right after assigning it.
    fleetCache = null;
    res.json({ slip: updated });
  } catch (error) {
    console.error('Error assigning vehicle from vehicle planning:', error);
    res.status(500).json({ message: 'Failed to assign vehicle' });
  }
});

export default router;
