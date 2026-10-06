import { Router, Request, Response } from 'express';
import { Client } from '@notionhq/client';
import { storage } from '../storage';
import { pool } from '../db';
import { requirePageAccess, requirePageWrite } from '../lib/pageAccess';
import { fetchProformaOrdersFromNotion, writeOrderToDb, type OrderData } from '../services/proformaNotionSync';
import { syncOrderToNotion, settleNotionSync, watchStatusAfterVehicleChange, type NotionSyncOutcome } from '../services/notionOrderStatusSync';
import type { VehiclePlanningOrderEntry } from '@shared/schema';

// Vehicle Planning — a Gantt-style "when is each vehicle free" view over a configurable slice of
// the fleet, so a planner can see which vehicle to assign a pending order to.
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
//
// Only ever called from runVehiclePlanningSync now (manual "Sync from Notion" button + the 24h
// timer) — never from the page-load GET, which reads vehicle_planning_state instead.
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

// ─── Company filter settings ───────────────────────────────────────────────

const DEFAULT_COMPANY_FILTERS = ['krupa', 'transport'];

// Vehicle Planning's own company scope — deliberately separate from Loading's
// qualifiesForLoadingVehiclePicker (krupa/dummy): this page's default fleet is krupa + transport,
// and unlike Loading's picker it's meant to be widened by whoever's using the page, via the
// company filter control, not hardcoded.
function qualifiesForVehiclePlanning(company: string | null | undefined, filters: string[]): boolean {
  const c = (company ?? '').toLowerCase();
  return filters.some((f) => c.includes(f.toLowerCase()));
}

async function getCompanyFilters(): Promise<string[]> {
  const { rows } = await pool.query(`SELECT company_filters AS "companyFilters" FROM vehicle_planning_settings ORDER BY id LIMIT 1`);
  return rows[0]?.companyFilters ?? DEFAULT_COMPANY_FILTERS;
}

router.get('/vehicle-planning/settings', requirePageAccess('vehicle-planning'), async (_req: Request, res: Response) => {
  try {
    const companyFilters = await getCompanyFilters();
    const all = await storage.getAllVehicleInfo();
    const availableCompanies = Array.from(new Set(all.map((v) => v.company).filter((c): c is string => !!c))).sort();
    res.json({ companyFilters, availableCompanies });
  } catch (error) {
    console.error('Error loading vehicle planning settings:', error);
    res.status(500).json({ message: 'Failed to load settings' });
  }
});

router.post('/vehicle-planning/settings', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const companyFilters = Array.isArray(req.body?.companyFilters)
      ? req.body.companyFilters.map((f: unknown) => String(f).trim()).filter(Boolean)
      : null;
    if (!companyFilters || companyFilters.length === 0) {
      return res.status(400).json({ message: 'companyFilters must be a non-empty array' });
    }
    await pool.query(
      `UPDATE vehicle_planning_settings SET company_filters = $1
       WHERE id = (SELECT id FROM vehicle_planning_settings ORDER BY id LIMIT 1)`,
      [JSON.stringify(companyFilters)],
    );
    res.json({ companyFilters });
  } catch (error) {
    console.error('Error saving vehicle planning settings:', error);
    res.status(500).json({ message: 'Failed to save settings' });
  }
});

// ─── Sync from Notion (manual button + 24h automatic timer) ───────────────

// Narrow date window for a scoped single-order proforma lookup (assign-flow fallback) — wide
// enough to cover almost any real order without turning into "sync everything".
function recentWindow(): { startDate: string; endDate: string } {
  const start = new Date();
  start.setDate(start.getDate() - 45);
  const end = new Date();
  end.setDate(end.getDate() + 7);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

// Builds one order_history entry for a vehicle's current live order, cross-referencing
// proforma_slips by order number (linked, never relied on for "which order is current"). If the
// slip doesn't exist locally yet, falls back to whatever Notion has for that order number — via
// getNotionOrders, a cache shared across the WHOLE sync run (fetchProformaOrdersFromNotion pulls
// its entire date window, not one order, so calling it per-vehicle would mean hundreds of
// redundant full-window Notion fetches instead of at most one).
async function buildHistoryEntry(
  vehicle: { vehicleNumber: string | null },
  currentOrder: LiveOrder,
  stateByPlant: Map<string, string | null>,
  getNotionOrders: () => Promise<Map<string, OrderData>>,
): Promise<VehiclePlanningOrderEntry> {
  let slip = await storage.getProformaSlipByOrderNumber(currentOrder.orderNumber);
  if (!slip) {
    try {
      const ordersMap = await getNotionOrders();
      const orderData = ordersMap.get(currentOrder.orderNumber);
      if (orderData) {
        await writeOrderToDb(orderData);
        slip = await storage.getProformaSlipByOrderNumber(currentOrder.orderNumber);
      }
    } catch (err) {
      console.error(`[Vehicle Planning] Scoped proforma sync failed for order ${currentOrder.orderNumber}:`, err);
    }
  }

  const vehicleMismatch = !!(slip?.vehicleNumber && vehicle.vehicleNumber && slip.vehicleNumber !== vehicle.vehicleNumber);
  const plantState = currentOrder.plant ? stateByPlant.get(currentOrder.plant.trim().toLowerCase()) ?? null : null;

  return {
    orderNumber: currentOrder.orderNumber,
    proformaSlipId: slip?.id ?? null,
    orderDate: currentOrder.orderDate,
    status: currentOrder.status,
    driver: currentOrder.driver,
    tripCompletesOn: currentOrder.tripCompletesOn,
    tripDays: currentOrder.tripDays,
    partyName: slip?.partyName ?? currentOrder.partyName,
    plant: currentOrder.plant,
    state: plantState,
    vehicleMismatch,
    mismatchProformaVehicleNumber: vehicleMismatch ? slip!.vehicleNumber : null,
    // Filled in by upsertHistoryEntry, which can see whether this order was already terminal as
    // of an earlier sync — this function builds a fresh snapshot each time, with no memory of that.
    actualCompletedAt: null,
  };
}

// Reads the existing order_history array for a vehicle, replaces the entry with the same order
// number (or appends if new), and writes it back. Also creates the vehicle_planning_state row if
// this vehicle has never been synced before.
async function upsertHistoryEntry(vehicleId: number, entry: VehiclePlanningOrderEntry): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, order_history AS "orderHistory" FROM vehicle_planning_state WHERE vehicle_id = $1`,
    [vehicleId],
  );
  const existingHistory: VehiclePlanningOrderEntry[] = rows[0]?.orderHistory ?? [];
  const previousEntry = existingHistory.find((e) => e.orderNumber === entry.orderNumber);
  // Once set, this never moves — it's "the sync that first saw this go terminal", not "the most
  // recent sync where it happened to still be terminal". A status that was already terminal last
  // time keeps its original observed date; one that's terminal for the first time right now gets
  // today's date; one that isn't terminal at all yet stays null.
  if (previousEntry?.actualCompletedAt) {
    entry.actualCompletedAt = previousEntry.actualCompletedAt;
  } else if (TERMINAL_STATUSES.has(String(entry.status ?? '').toUpperCase())) {
    entry.actualCompletedAt = new Date().toISOString().slice(0, 10);
  }
  const nextHistory = existingHistory.filter((e) => e.orderNumber !== entry.orderNumber);
  nextHistory.push(entry);

  if (rows[0]) {
    await pool.query(
      `UPDATE vehicle_planning_state SET order_history = $1, last_synced_at = now() WHERE vehicle_id = $2`,
      [JSON.stringify(nextHistory), vehicleId],
    );
  } else {
    await pool.query(
      `INSERT INTO vehicle_planning_state (vehicle_id, order_history, last_synced_at) VALUES ($1, $2, now())`,
      [vehicleId, JSON.stringify(nextHistory)],
    );
  }
}

// Runs `task` over `items` with at most `limit` in flight at once — plain Promise.all with no cap
// fires one query per item ALL AT ONCE; against an 849-vehicle fleet and a 20-connection pool
// (server/db.ts), that's exactly what crashed the whole server with "timeout exceeded when trying
// to connect" (an unhandled rejection from inside this function, with nothing catching it before
// it reached the process) — most of those queries were just queued past the pool's own timeout,
// competing with every other request the app was serving at the same moment.
async function mapWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await task(items[idx]);
    }
  });
  await Promise.all(workers);
}

let isVehiclePlanningSyncing = false;

// The only function that talks to Notion for Vehicle Planning. Runs for every vehicle currently
// matching the saved company filter, finds its current order, links it to proforma_slips, and
// upserts the result into vehicle_planning_state. Called by the manual "Sync from Notion" button
// and by the 24h automatic timer in server/index.ts — never by the page-load GET.
export async function runVehiclePlanningSync(): Promise<{ syncedVehicles: number; mismatches: number }> {
  if (isVehiclePlanningSyncing) {
    console.log('[Vehicle Planning] Sync already in progress, skipping this run');
    return { syncedVehicles: 0, mismatches: 0 };
  }
  isVehiclePlanningSyncing = true;
  console.log('[Vehicle Planning] Sync started');
  try {
    const companyFilters = await getCompanyFilters();
    const all = await storage.getAllVehicleInfo();
    const fleet = all.filter((v) => qualifiesForVehiclePlanning(v.company, companyFilters));

    // Ensure every qualifying vehicle has a state row, even one with no current order yet, so it
    // shows up (as "no history") rather than being invisible until its first order. Capped at 8
    // at once (see mapWithConcurrency's own comment) instead of firing all 849 simultaneously.
    await mapWithConcurrency(fleet, 8, async (v) => {
      await pool.query(
        `INSERT INTO vehicle_planning_state (vehicle_id, order_history) VALUES ($1, '[]')
         ON CONFLICT (vehicle_id) DO NOTHING`,
        [v.id],
      );
    });

    const vehiclesWithNotionId = fleet.filter((v): v is typeof v & { notionPageId: string } => !!v.notionPageId);
    const currentOrderByVehicle = await fetchCurrentOrdersByVehicle(vehiclesWithNotionId.map((v) => v.notionPageId));

    const allPlants = await storage.getAllPlants();
    const stateByPlant = new Map(allPlants.map((p) => [p.name.trim().toLowerCase(), p.state] as const));

    // Fetched at most ONCE for this whole run, the first time some vehicle's order isn't already
    // in proforma_slips — every other vehicle missing a slip reuses this same resolved (or
    // REJECTED) promise instead of each triggering its own full date-window pull from Notion. A
    // failure is deliberately cached too, not retried per vehicle — if Notion is unreachable this
    // run, retrying for every single vehicle missing a slip just turns one outage into dozens of
    // doomed network calls; this run simply leaves those entries unlinked and the next sync (in
    // 24h, or a manual click) tries again fresh.
    let notionOrdersPromise: Promise<Map<string, OrderData>> | null = null;
    const getNotionOrders = () => {
      if (!notionOrdersPromise) {
        const { startDate, endDate } = recentWindow();
        notionOrdersPromise = fetchProformaOrdersFromNotion(startDate, endDate);
      }
      return notionOrdersPromise;
    };

    let mismatches = 0;
    for (const v of fleet) {
      const currentOrder = v.notionPageId ? currentOrderByVehicle.get(v.notionPageId) ?? null : null;
      if (!currentOrder) {
        await pool.query(`UPDATE vehicle_planning_state SET last_synced_at = now() WHERE vehicle_id = $1`, [v.id]);
        continue;
      }
      const entry = await buildHistoryEntry(v, currentOrder, stateByPlant, getNotionOrders);
      if (entry.vehicleMismatch) mismatches++;
      await upsertHistoryEntry(v.id, entry);
    }

    console.log(`[Vehicle Planning] Sync finished — ${fleet.length} vehicle(s) checked, ${mismatches} mismatch(es)`);
    return { syncedVehicles: fleet.length, mismatches };
  } finally {
    isVehiclePlanningSyncing = false;
  }
}

router.post('/vehicle-planning/sync', requirePageWrite('vehicle-planning'), async (_req: Request, res: Response) => {
  try {
    const result = await runVehiclePlanningSync();
    res.json(result);
  } catch (error) {
    console.error('Error running vehicle planning sync:', error);
    res.status(500).json({ message: 'Failed to sync from Notion' });
  }
});

// ─── Resolve a vehicle-number mismatch (Notion's relation vs. proforma_slips) ──

router.post('/vehicle-planning/resolve-mismatch', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const vehicleId = Number(req.body?.vehicleId);
    const orderNumber = String(req.body?.orderNumber ?? '').trim();
    const keep = req.body?.keep === 'proforma' ? 'proforma' : 'notion';
    if (!vehicleId || !orderNumber) return res.status(400).json({ message: 'vehicleId and orderNumber are required' });

    const { rows } = await pool.query(
      `SELECT order_history AS "orderHistory" FROM vehicle_planning_state WHERE vehicle_id = $1`,
      [vehicleId],
    );
    const history: VehiclePlanningOrderEntry[] = rows[0]?.orderHistory ?? [];
    const entry = history.find((e) => e.orderNumber === orderNumber);
    if (!entry) return res.status(404).json({ message: 'No matching order history entry found' });

    if (keep === 'notion') {
      const vehicle = await storage.getVehicleInfo(vehicleId);
      const slip = await storage.getProformaSlipByOrderNumber(orderNumber);
      if (vehicle?.vehicleNumber && slip) {
        await storage.updateProformaSlip(slip.id, { vehicleNumber: vehicle.vehicleNumber, vehicleInfoId: vehicle.id } as any);
      }
    }
    // keep === 'proforma': proforma_slips is treated as already correct — nothing to write there.

    entry.vehicleMismatch = false;
    entry.mismatchProformaVehicleNumber = null;
    await pool.query(
      `UPDATE vehicle_planning_state SET order_history = $1 WHERE vehicle_id = $2`,
      [JSON.stringify(history), vehicleId],
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Error resolving vehicle planning mismatch:', error);
    res.status(500).json({ message: 'Failed to resolve mismatch' });
  }
});

// GET /api/vehicle-planning/vehicles/:id/history — every past order this vehicle has carried,
// newest first. Fetched on demand (clicking a row), not bundled into the main /vehicles list —
// the fleet-wide response stays small, and most of the time nobody clicks into any given row.
router.get('/vehicle-planning/vehicles/:id/history', requirePageAccess('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const vehicleId = Number(req.params.id);
    if (!Number.isFinite(vehicleId)) return res.status(400).json({ message: 'Invalid vehicle id' });
    const { rows } = await pool.query(
      `SELECT order_history AS "orderHistory" FROM vehicle_planning_state WHERE vehicle_id = $1`,
      [vehicleId],
    );
    const history: VehiclePlanningOrderEntry[] = rows[0]?.orderHistory ?? [];
    const sorted = [...history].sort((a, b) => (b.orderDate ?? '').localeCompare(a.orderDate ?? ''));
    res.json({ history: sorted });
  } catch (error) {
    console.error('Error loading vehicle order history:', error);
    res.status(500).json({ message: 'Failed to load order history' });
  }
});

// ─── GET /api/vehicle-planning/vehicles — reads vehicle_planning_state only, never Notion ──

router.get('/vehicle-planning/vehicles', requirePageAccess('vehicle-planning'), async (_req: Request, res: Response) => {
  try {
    const companyFilters = await getCompanyFilters();
    const all = await storage.getAllVehicleInfo();
    const fleet = all.filter((v) => qualifiesForVehiclePlanning(v.company, companyFilters));

    const { rows: stateRows } = await pool.query(
      `SELECT vehicle_id AS "vehicleId", order_history AS "orderHistory", last_synced_at AS "lastSyncedAt"
       FROM vehicle_planning_state WHERE vehicle_id = ANY($1)`,
      [fleet.map((v) => v.id)],
    );
    const stateByVehicleId = new Map(stateRows.map((r: any) => [r.vehicleId, r]));

    const rows = fleet.map((v) => {
      const state = stateByVehicleId.get(v.id);
      const history: VehiclePlanningOrderEntry[] = state?.orderHistory ?? [];
      // "Current" = the single most-recently-dated entry, regardless of status — same "latest
      // wins" rule the old live Notion fetch used (busy/free is a separate computed flag below).
      const currentOrder = history.length > 0
        ? history.reduce((latest, e) => (!latest || (e.orderDate ?? '') > (latest.orderDate ?? '') ? e : latest))
        : null;

      if (!v.vehicleNumber || !currentOrder) {
        return {
          id: v.id, vehicleNumber: v.vehicleNumber ?? null, rtoNumber: v.rtoNumber, driver: v.driver,
          state: null, company: v.company, currentOrder: null, busy: false, busyUntil: null, tripDays: null,
          hasHistory: history.length > 0, lastSyncedAt: state?.lastSyncedAt ?? null,
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

      return {
        id: v.id, vehicleNumber: v.vehicleNumber, rtoNumber: v.rtoNumber,
        // Vehicle Master's own driver field is empty for this whole fleet — the real driver is
        // recorded per TRIP in Notion (currentOrder.driver), not per vehicle. Vehicle Master's
        // value is kept as a fallback only, for a vehicle whose Notion driver field is blank.
        driver: currentOrder.driver ?? v.driver,
        state: currentOrder.state, company: v.company,
        currentOrder: {
          orderNumber: currentOrder.orderNumber, partyName: currentOrder.partyName,
          plant: currentOrder.plant, orderDate: currentOrder.orderDate, notionStatus: currentOrder.status,
          // Always present (not just when busy) — the Gantt bar itself needs this to draw a
          // PAST trip's bar too, not only a currently-ongoing one. busyUntil below stays the
          // "is it free yet" signal; this is just "when did/does this trip end".
          tripCompletesOn: currentOrder.tripCompletesOn,
          vehicleMismatch: currentOrder.vehicleMismatch, mismatchProformaVehicleNumber: currentOrder.mismatchProformaVehicleNumber,
        },
        busy, busyUntil, tripDays: currentOrder.tripDays,
        hasHistory: true, lastSyncedAt: state?.lastSyncedAt ?? null,
      };
    });

    res.json({ vehicles: rows, testModeOrderNumbers: TEST_MODE_ORDER_NUMBERS, companyFilters });
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

    let slip = await storage.getProformaSlipByOrderNumber(orderNumber);
    // Not found locally — try a scoped live pull from Notion before giving up, since a brand new
    // order may not have been synced (manually or by the 24h timer) yet.
    if (!slip) {
      try {
        const { startDate, endDate } = recentWindow();
        const ordersMap = await fetchProformaOrdersFromNotion(startDate, endDate);
        const orderData: OrderData | undefined = ordersMap.get(orderNumber);
        if (orderData) {
          await writeOrderToDb(orderData);
          slip = await storage.getProformaSlipByOrderNumber(orderNumber);
        }
      } catch (err) {
        console.error(`[Vehicle Planning] Scoped proforma fetch failed for order ${orderNumber}:`, err);
      }
    }
    if (!slip) return res.status(404).json({ message: `Order ${orderNumber} not found in Notion.` });

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
    // Same shared update the Loading page uses: compare first, write, read back to confirm, and on
    // a failure try again every 2 minutes up to 5 tries in total (see notionOrderStatusSync.ts).
    const notionOutcome: NotionSyncOutcome = vehicle.notionPageId
      ? await settleNotionSync(syncOrderToNotion(orderNumber, { vehiclePageId: vehicle.notionPageId }, { userCode }))
      : { state: 'skipped', message: `${vehicle.vehicleNumber} has no Notion page, so Notion was not updated with this vehicle.` };

    // Notion's automation may change the status after a vehicle is set — two minutes from now the
    // status of a load started in the app is put back (Loading / Ready for Dispatch).
    void watchStatusAfterVehicleChange(orderNumber, { userCode });

    // Reflect the assignment into this vehicle's local history immediately, so the Gantt shows it
    // without waiting for the next Sync — driver/trip fields fill in on the next sync.
    await upsertHistoryEntry(vehicle.id, {
      orderNumber,
      proformaSlipId: updated.id,
      orderDate: updated.orderDate ?? null,
      status: updated.notionStatus ?? null,
      driver: null,
      tripCompletesOn: null,
      tripDays: null,
      partyName: updated.partyName ?? null,
      plant: updated.plant ?? null,
      state: null,
      vehicleMismatch: false,
      mismatchProformaVehicleNumber: null,
      actualCompletedAt: null,
    });

    res.json({ slip: updated, notion: notionOutcome });
  } catch (error) {
    console.error('Error assigning vehicle from vehicle planning:', error);
    res.status(500).json({ message: 'Failed to assign vehicle' });
  }
});

export default router;
