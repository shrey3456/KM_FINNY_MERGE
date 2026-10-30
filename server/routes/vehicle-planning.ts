import { Router, Request, Response } from 'express';
import { Client } from '@notionhq/client';
import { storage } from '../storage';
import { pool } from '../db';
import { requirePageAccess, requirePageWrite, WRITE_ADMIN_ROLES } from '../lib/pageAccess';
import { listNotionDrivers, readNotionOrderInfo } from '../services/vehiclePlanningNotion';
import { fetchProformaOrdersFromNotion, writeOrderToDb } from '../services/proformaNotionSync';
import { syncOrderToNotion, settleNotionSync, watchStatusAfterVehicleChange, type NotionSyncOutcome } from '../services/notionOrderStatusSync';
import type { VehiclePlanningOrderEntry } from '@shared/schema';
import { refreshVehicleSpecsFromNotion } from '../services/notionVehicleSync';
import { computeVehicleTrips, groupEntries, groupPrimaryOf, mergeLocalTripFields, checkArrival, checkExpectedEnd, toDmy, addDays, todayIst } from '../lib/vehicleTrips';

// Vehicle Planning — a Gantt-style "when is each vehicle free" view over a configurable slice of
// the fleet, so a planner can see which vehicle to assign a pending order to.
//
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

// One Notion order page as a LiveOrder (null when it has no order number).
function liveOrderFromPage(page: any): LiveOrder | null {
  const orderNumber = extractPropertyValue(page.properties['Order No. :']);
  if (!orderNumber) return null;
  return {
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
}

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
          const order = liveOrderFromPage(page);
          if (!order) continue;
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

// EVERY order dated on or after `sinceIso` (YYYY-MM-DD) on the given vehicles, newest first, found the same way (the order database's "Vehi  No. :" relation).
// Used by Refresh from Notion when a start date is set: all the orders from that day, not only each vehicle's latest. Pages through everything; nothing is written here.
export async function fetchOrdersSince(vehicleNotionPageIds: string[], sinceIso: string): Promise<Map<string, LiveOrder[]>> {
  const byVehicle = new Map<string, LiveOrder[]>();
  if (!ORDER_DATABASE_ID || vehicleNotionPageIds.length === 0) return byVehicle;
  const CHUNK_SIZE = 50;
  const chunks: string[][] = [];
  for (let i = 0; i < vehicleNotionPageIds.length; i += CHUNK_SIZE) chunks.push(vehicleNotionPageIds.slice(i, i + CHUNK_SIZE));
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const wanted = new Set(chunk);
      let cursor: string | undefined;
      let pages = 0;
      do {
        const resp: any = await notion.databases.query({
          database_id: ORDER_DATABASE_ID,
          filter: {
            and: [
              { or: chunk.map((id) => ({ property: 'Vehi  No. :', relation: { contains: id } })) },
              { property: 'Ord Date :', date: { on_or_after: sinceIso } },
            ],
          },
          sorts: [{ property: 'Ord Date :', direction: 'descending' }],
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        for (const page of resp.results) {
          const order = liveOrderFromPage(page);
          if (!order) continue;
          for (const r of (page.properties['Vehi  No. :']?.relation ?? []) as { id: string }[]) {
            if (!wanted.has(r.id)) continue;
            const list = byVehicle.get(r.id) ?? [];
            if (!list.some((o) => o.orderNumber === order.orderNumber)) list.push(order);
            byVehicle.set(r.id, list);
          }
        }
        cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
      } while (cursor && ++pages < 80);
    } catch (err) {
      console.error('[Vehicle Planning] Reading the orders since', sinceIso, 'failed for a batch of vehicles:', err);
    }
  }));
  return byVehicle;
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
    // The settings table starts empty and nothing creates its row, so a plain UPDATE saved nothing at all (the page said "saved" and the choice was
    // gone on the next load). Update the row when there is one, otherwise create it.
    const updated = await pool.query(
      `UPDATE vehicle_planning_settings SET company_filters = $1
       WHERE id = (SELECT id FROM vehicle_planning_settings ORDER BY id LIMIT 1)`,
      [JSON.stringify(companyFilters)],
    );
    if (!updated.rowCount) {
      await pool.query(`INSERT INTO vehicle_planning_settings (company_filters) VALUES ($1)`, [JSON.stringify(companyFilters)]);
    }
    res.json({ companyFilters });
  } catch (error) {
    console.error('Error saving vehicle planning settings:', error);
    res.status(500).json({ message: 'Failed to save settings' });
  }
});

// ─── Sync from Notion (manual button + 24h automatic timer) ───────────────

// Narrow date window for fetching ONE order's slip from Notion when the planner asks for it (POST /vehicle-planning/fetch-slip) — wide
// enough to cover almost any real order without turning into "sync everything".
function recentWindow(): { startDate: string; endDate: string } {
  const start = new Date();
  start.setDate(start.getDate() - 45);
  const end = new Date();
  end.setDate(end.getDate() + 7);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

// Builds one order_history entry for a vehicle's current live order, cross-referencing
// proforma_slips by order number (linked, never relied on for "which order is current"). Vehicle
// Planning NEVER creates a slip: when the order isn't in our system the entry is kept (so the planner
// can see that Notion has this vehicle on an order) but flagged `notInSystem`, and the planner chooses
// whether to fetch that slip (POST /vehicle-planning/fetch-slip).
async function buildHistoryEntry(
  vehicle: { vehicleNumber: string | null },
  currentOrder: LiveOrder,
  stateByPlant: Map<string, string | null>,
): Promise<VehiclePlanningOrderEntry> {
  const slip = await storage.getProformaSlipByOrderNumber(currentOrder.orderNumber);

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
    notInSystem: !slip,
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
  // A Refresh rebuilds the trip from Notion's data; the arrival and the stretched end a person recorded must survive it.
  mergeLocalTripFields(previousEntry, entry);
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

// The only function that talks to Notion for Vehicle Planning. Runs for every vehicle (from Vehicle Master) currently
// matching the saved company filter, finds its current order, links it to a proforma slip that is ALREADY in our system
// (it never creates one), and upserts the result into vehicle_planning_state. Called by the manual "Sync from Notion" button
// and by the 24h automatic timer in server/index.ts — never by the page-load GET.
export async function runVehiclePlanningSync(): Promise<{ syncedVehicles: number; mismatches: number; notInSystem: number; fetchedOrders: number; specsUpdated?: number }> {
  if (isVehiclePlanningSyncing) {
    console.log('[Vehicle Planning] Sync already in progress, skipping this run');
    return { syncedVehicles: 0, mismatches: 0, notInSystem: 0, fetchedOrders: 0 };
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
    // With a start date set (the "From" date next to Refresh, or the day a reset started from): EVERY order dated on or after it, for each of the selected
    // companies' vehicles. Without one: just each vehicle's latest order, as before.
    const planningStart = await getPlanningStartDate();
    const notionIds = vehiclesWithNotionId.map((v) => v.notionPageId);
    const ordersSinceByVehicle = planningStart ? await fetchOrdersSince(notionIds, planningStart) : null;
    const currentOrderByVehicle = ordersSinceByVehicle ? null : await fetchCurrentOrdersByVehicle(notionIds);

    const allPlants = await storage.getAllPlants();
    const stateByPlant = new Map(allPlants.map((p) => [p.name.trim().toLowerCase(), p.state] as const));

    let mismatches = 0;
    let notInSystem = 0;
    let fetchedOrders = 0;
    for (const v of fleet) {
      const latest = !ordersSinceByVehicle && v.notionPageId ? currentOrderByVehicle?.get(v.notionPageId) ?? null : null;
      const orders: LiveOrder[] = ordersSinceByVehicle
        ? (v.notionPageId ? ordersSinceByVehicle.get(v.notionPageId) ?? [] : [])
        : (latest ? [latest] : []);
      const usable = orders.filter((o) => !planningStart || String(o.orderDate ?? '').slice(0, 10) >= planningStart);
      if (usable.length === 0) {
        await pool.query(`UPDATE vehicle_planning_state SET last_synced_at = now() WHERE vehicle_id = $1`, [v.id]);
        continue;
      }
      for (const order of usable) {
        const entry = await buildHistoryEntry(v, order, stateByPlant);
        if (entry.vehicleMismatch) mismatches++;
        if (entry.notInSystem) notInSystem++;
        await upsertHistoryEntry(v.id, entry);
        fetchedOrders++;
      }
    }
    // Every vehicle has now had its first pass.
    await pool.query(`UPDATE vehicle_planning_state SET setup_done = true WHERE vehicle_id = ANY($1::int[]) AND setup_done = false`, [fleet.map((v) => v.id)]);

    // The vehicles' body type and volume come in with the same Refresh (best effort: a failure here never fails the Refresh).
    let specsUpdated = 0;
    try { const s = await refreshVehicleSpecsFromNotion(); specsUpdated = s.bodyTypeChanged + s.volumeFilled; } catch (err) { console.error('[Vehicle Planning] Could not read body type / volume from Notion:', err instanceof Error ? err.message : err); }

    console.log(`[Vehicle Planning] Sync finished — ${fleet.length} vehicle(s) checked, ${fetchedOrders} order(s) read${planningStart ? ` from ${planningStart}` : ' (latest per vehicle)'}, ${mismatches} mismatch(es), ${notInSystem} order(s) not in our system`);
    return { syncedVehicles: fleet.length, mismatches, notInSystem, fetchedOrders, specsUpdated };
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

// ─── Review: which orders Notion has on a vehicle that our system does not have ─────────────────────────────────

// Notion's recent orders, read once and kept for two minutes, so creating several slips in a row (the Review dialog creates them one at a time to show progress)
// does not read Notion again for each one.
let recentOrdersCache: { at: number; map: Awaited<ReturnType<typeof fetchProformaOrdersFromNotion>> } | null = null;
async function recentNotionOrders() {
  if (recentOrdersCache && Date.now() - recentOrdersCache.at < 2 * 60 * 1000) return recentOrdersCache.map;
  const { startDate, endDate } = recentWindow();
  const map = await fetchProformaOrdersFromNotion(startDate, endDate);
  recentOrdersCache = { at: Date.now(), map };
  return map;
}

// GET /api/vehicle-planning/review - every vehicle's latest order (from what the last Refresh stored) with whether our system has its slip. Writes nothing and does not
// call Notion: it shows what the last Refresh found.
router.get('/vehicle-planning/review', requirePageAccess('vehicle-planning'), async (_req: Request, res: Response) => {
  try {
    const companyFilters = await getCompanyFilters();
    const all = await storage.getAllVehicleInfo();
    const fleet = all.filter((v) => qualifiesForVehiclePlanning(v.company, companyFilters));
    const byId = new Map(fleet.map((v) => [v.id, v] as const));
    const { rows } = await pool.query(`SELECT vehicle_id AS "vehicleId", order_history AS "orderHistory" FROM vehicle_planning_state WHERE jsonb_array_length(order_history) > 0`);
    const latest: { vehicleId: number; vehicleNumber: string | null; entry: VehiclePlanningOrderEntry }[] = [];
    for (const r of rows as any[]) {
      const v = byId.get(r.vehicleId);
      if (!v) continue;
      const history: VehiclePlanningOrderEntry[] = r.orderHistory ?? [];
      const newest = [...history].sort((a, b) => String(b.orderDate ?? '').localeCompare(String(a.orderDate ?? '')))[0];
      if (newest) latest.push({ vehicleId: v.id, vehicleNumber: v.vehicleNumber, entry: newest });
    }
    const numbers = Array.from(new Set(latest.map((l) => l.entry.orderNumber)));
    const { rows: have } = numbers.length
      ? await pool.query(`SELECT order_number AS "orderNumber" FROM proforma_slips WHERE order_number = ANY($1::text[])`, [numbers])
      : { rows: [] as any[] };
    const inSystem = new Set(have.map((h: any) => h.orderNumber));
    const items = latest.map((l) => ({
      vehicleId: l.vehicleId, vehicleNumber: l.vehicleNumber, orderNumber: l.entry.orderNumber, orderDate: l.entry.orderDate ?? null,
      partyName: l.entry.partyName ?? null, plant: l.entry.plant ?? null, status: l.entry.status ?? null, inSystem: inSystem.has(l.entry.orderNumber),
    }));
    // Not-in-system first, then by vehicle number.
    items.sort((a, b) => Number(a.inSystem) - Number(b.inSystem) || (a.vehicleNumber ?? '').localeCompare(b.vehicleNumber ?? '', undefined, { numeric: true }));
    res.json({ items, missing: items.filter((i) => !i.inSystem).length });
  } catch (error) {
    console.error('Error building the vehicle planning review:', error);
    res.status(500).json({ message: 'Failed to load the review' });
  }
});

// ─── Fetch ONE slip from Notion into our system (planner's choice) ─────────────

// POST /api/vehicle-planning/fetch-slip — body: { orderNumber }. Notion has this order on a vehicle but our system has no slip for it
// (history entry flagged notInSystem). Only this one order is written, and only when the planner asks (ticks it in the Review dialog).
router.post('/vehicle-planning/fetch-slip', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const orderNumber = String(req.body?.orderNumber ?? '').trim();
    if (!orderNumber) return res.status(400).json({ message: 'orderNumber is required' });
    let slip = await storage.getProformaSlipByOrderNumber(orderNumber);
    if (!slip) {
      const orderData = (await recentNotionOrders()).get(orderNumber);
      if (!orderData) return res.status(404).json({ message: `Order ${orderNumber} was not found in Notion.` });
      await writeOrderToDb(orderData);
      slip = await storage.getProformaSlipByOrderNumber(orderNumber);
      const { userCode, userName } = who(req);
      if (slip && userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'create', entityType: 'proforma_slip', entityId: orderNumber, details: `Slip for order #${orderNumber} fetched from Notion by ${userName ?? userCode} (Vehicle Planning review)`, userCode, userName });
    }
    if (!slip) return res.status(500).json({ message: 'The slip could not be created.' });

    // Every vehicle history entry for this order is now linked to the slip and no longer flagged.
    const { rows } = await pool.query(
      `SELECT vehicle_id AS "vehicleId", order_history AS "orderHistory" FROM vehicle_planning_state WHERE order_history @> $1::jsonb`,
      [JSON.stringify([{ orderNumber }])],
    );
    for (const r of rows as any[]) {
      const history: VehiclePlanningOrderEntry[] = r.orderHistory ?? [];
      let changed = false;
      for (const e of history) {
        if (e.orderNumber !== orderNumber) continue;
        e.proformaSlipId = slip.id; e.notInSystem = false; changed = true;
        if (!e.partyName && slip.partyName) e.partyName = slip.partyName;
        const veh = await storage.getVehicleInfo(r.vehicleId);
        if (slip.vehicleNumber && veh?.vehicleNumber && slip.vehicleNumber !== veh.vehicleNumber) {
          e.vehicleMismatch = true; e.mismatchProformaVehicleNumber = slip.vehicleNumber;
        }
      }
      if (changed) await pool.query(`UPDATE vehicle_planning_state SET order_history = $1 WHERE vehicle_id = $2`, [JSON.stringify(history), r.vehicleId]);
    }
    res.json({ slip });
  } catch (error) {
    console.error('Error fetching slip for vehicle planning:', error);
    res.status(500).json({ message: 'Failed to fetch the slip from Notion' });
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

// ─── What a person records on a trip: the real arrival, and a stretched (expected) end ─────────────────────

async function loadTrip(vehicleId: number, orderNumber: string) {
  const { rows } = await pool.query(`SELECT order_history AS "orderHistory" FROM vehicle_planning_state WHERE vehicle_id = $1`, [vehicleId]);
  const history: VehiclePlanningOrderEntry[] = rows[0]?.orderHistory ?? [];
  const entry = history.find((e) => e.orderNumber === orderNumber);
  return { history, entry };
}
async function saveHistory(vehicleId: number, history: VehiclePlanningOrderEntry[]) {
  await pool.query(`UPDATE vehicle_planning_state SET order_history = $1 WHERE vehicle_id = $2`, [JSON.stringify(history), vehicleId]);
}
const who = (req: Request): { userCode?: string; userName?: string } => { const u = req.user as any; return { userCode: u?.userCode ?? undefined, userName: u?.name ?? u?.username ?? undefined }; };
const tripsView = (history: VehiclePlanningOrderEntry[]) => { const vt = computeVehicleTrips(history); return { trips: vt.trips, freeFrom: vt.freeFrom, vehicleState: vt.vehicleState, conflicts: vt.conflicts }; };

// The orders of a trip (one, or several for a shared load) - what a person records on a trip is written to all of them - and the one that starts first, which the
// date checks use.
function tripEntries(history: VehiclePlanningOrderEntry[], orderNumber: string) {
  const group = groupEntries(history, orderNumber);
  const first = [...group].sort((a, b) => String(a.orderDate ?? '').localeCompare(String(b.orderDate ?? '')))[0];
  return { group, first };
}

// POST /api/vehicle-planning/status - body { vehicleId, status | null, days, comment }: the vehicle's own status on this page (parking, maintenance, breakdown ...).
// days >= 1 keeps it out of Available for that many days from today; 0 is just a label. status null (or empty) clears it. Our system only: Notion is untouched.
const VEHICLE_STATUSES = ['Gone for passing', 'Parcing', 'Parking', 'Parking maintenance', 'Road maintenance', 'Showroom maintenance', 'Breakdown'];
router.post('/vehicle-planning/status', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const vehicleId = Number(req.body?.vehicleId);
    if (!vehicleId) return res.status(400).json({ message: 'vehicleId is required' });
    const vehicle = await storage.getVehicleInfo(vehicleId);
    if (!vehicle) return res.status(404).json({ message: 'Vehicle not found' });
    const { userCode, userName } = who(req);
    const status = String(req.body?.status ?? '').trim();
    if (!status) {
      await pool.query(`DELETE FROM vehicle_planning_status WHERE vehicle_id = $1`, [vehicleId]);
      if (userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'delete', entityType: 'vehicle_status', entityId: String(vehicleId), details: `Status of ${vehicle.vehicleNumber ?? vehicleId} cleared by ${userName ?? userCode}`, userCode, userName });
      return res.json({ cleared: true });
    }
    if (!VEHICLE_STATUSES.includes(status)) return res.status(400).json({ message: 'Unknown status' });
    // Every status needs its days (or the date the vehicle is available again, which the page turns into days): 1 to 365.
    const days = Math.floor(Number(req.body?.days));
    if (!(days >= 1)) return res.status(400).json({ message: 'Enter the number of days (or pick the date it is available again).' });
    if (days > 365) return res.status(400).json({ message: 'Days can be at most 365.' });
    const comment = String(req.body?.comment ?? '').trim().slice(0, 300) || null;
    await pool.query(
      `INSERT INTO vehicle_planning_status (vehicle_id, status, start_day, days, comment, set_by_code, set_by_name, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (vehicle_id) DO UPDATE SET status = EXCLUDED.status, start_day = EXCLUDED.start_day, days = EXCLUDED.days, comment = EXCLUDED.comment,
         set_by_code = EXCLUDED.set_by_code, set_by_name = EXCLUDED.set_by_name, updated_at = NOW()`,
      [vehicleId, status, todayIst(), days, comment, userCode ?? null, userName ?? null],
    );
    if (userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'update', entityType: 'vehicle_status', entityId: String(vehicleId), details: `${vehicle.vehicleNumber ?? vehicleId}: ${status}${days ? ` for ${days} day${days === 1 ? '' : 's'}` : ''}${comment ? ` - ${comment}` : ''} (set by ${userName ?? userCode})`, userCode, userName });
    res.json({ status, days });
  } catch (error) {
    console.error('Error saving the vehicle status:', error);
    res.status(500).json({ message: 'Failed to save the status' });
  }
});

// POST /api/vehicle-planning/day-notes - body { vehicleId, day: 'YYYY-MM-DD', text }: the note for that vehicle on that day. An empty text removes it. Only our board; Notion is untouched.
router.post('/vehicle-planning/day-notes', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const vehicleId = Number(req.body?.vehicleId);
    const day = String(req.body?.day ?? '');
    if (!vehicleId || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())) return res.status(400).json({ message: 'vehicleId and a valid day are required' });
    const vehicle = await storage.getVehicleInfo(vehicleId);
    if (!vehicle) return res.status(404).json({ message: 'Vehicle not found' });
    const text = String(req.body?.text ?? '').trim().slice(0, 500);
    const { userCode, userName } = who(req);
    if (!text) {
      await pool.query(`DELETE FROM vehicle_planning_day_notes WHERE vehicle_id = $1 AND day = $2`, [vehicleId, day]);
      if (userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'delete', entityType: 'vehicle_day_note', entityId: `${vehicleId}:${day}`, details: `Note on ${vehicle.vehicleNumber ?? vehicleId} for ${day} removed by ${userName ?? userCode}`, userCode, userName });
      return res.json({ removed: true });
    }
    await pool.query(
      `INSERT INTO vehicle_planning_day_notes (vehicle_id, day, note, created_by_code, created_by_name, updated_at) VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (vehicle_id, day) DO UPDATE SET note = EXCLUDED.note, created_by_code = EXCLUDED.created_by_code, created_by_name = EXCLUDED.created_by_name, updated_at = NOW()`,
      [vehicleId, day, text, userCode ?? null, userName ?? null],
    );
    if (userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'update', entityType: 'vehicle_day_note', entityId: `${vehicleId}:${day}`, details: `Note on ${vehicle.vehicleNumber ?? vehicleId} for ${day} by ${userName ?? userCode}: ${text.slice(0, 120)}`, userCode, userName });
    res.json({ day, text, byName: userName ?? null });
  } catch (error) {
    console.error('Error saving the day note:', error);
    res.status(500).json({ message: 'Failed to save the note' });
  }
});

// POST /api/vehicle-planning/trips/arrival - body { vehicleId, orderNumber, arrivedOn: 'YYYY-MM-DD', note?, freeSameDay? } records the real arrival; { undo: true } clears it.
// freeSameDay (default true): the vehicle can go out again on the arrival day itself, so an order starting that day does not clash.
router.post('/vehicle-planning/trips/arrival', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const vehicleId = Number(req.body?.vehicleId);
    const orderNumber = String(req.body?.orderNumber ?? '').trim();
    if (!vehicleId || !orderNumber) return res.status(400).json({ message: 'vehicleId and orderNumber are required' });
    const { history, entry } = await loadTrip(vehicleId, orderNumber);
    if (!entry) return res.status(404).json({ message: 'That trip is not on this vehicle.' });
    const { group, first } = tripEntries(history, orderNumber);
    const { userCode, userName } = who(req);
    const vehicle = await storage.getVehicleInfo(vehicleId);
    const orders = group.map((g) => `#${g.orderNumber}`).join(', ');
    if (req.body?.undo === true) {
      const was = group.find((g) => g.arrivedOn)?.arrivedOn;
      if (!was) return res.status(409).json({ message: 'No arrival is recorded for this trip.' });
      for (const g of group) { g.arrivedOn = null; g.arrivedByCode = null; g.arrivedByName = null; g.arrivedAt = null; g.arrivalNote = null; g.freeSameDay = null; }
      await saveHistory(vehicleId, history);
      if (userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'update', entityType: 'vehicle_trip', entityId: orderNumber, details: `Arrival of ${vehicle?.vehicleNumber ?? vehicleId} on order ${orders} undone by ${userName ?? userCode} (it was ${was})`, userCode, userName });
      return res.json(tripsView(history));
    }
    const problem = checkArrival(first, req.body?.arrivedOn);
    if (problem) return res.status(400).json({ message: problem });
    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 300) : null;
    const sameDay = req.body?.freeSameDay !== false;
    const plannedLast = computeVehicleTrips(group).trips[0]?.plannedLastDay ?? String(req.body.arrivedOn);
    for (const g of group) {
      g.arrivedOn = String(req.body.arrivedOn);
      g.arrivedByCode = userCode ?? null; g.arrivedByName = userName ?? null; g.arrivedAt = new Date().toISOString();
      g.arrivalNote = note; g.freeSameDay = sameDay;
    }
    await saveHistory(vehicleId, history);
    if (userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'update', entityType: 'vehicle_trip', entityId: orderNumber, details: `${vehicle?.vehicleNumber ?? vehicleId} marked arrived on ${req.body.arrivedOn} for order ${orders} by ${userName ?? userCode}${sameDay ? ' (can go out again the same day)' : ''}${note ? ` — ${note}` : ''}`, userCode, userName });
    const view = tripsView(history);
    // Early arrival: the vehicle is free sooner than planned, so say how many orders are waiting for a vehicle.
    const early = !!view.freeFrom && String(req.body.arrivedOn) < plannedLast;
    res.json({ ...view, early, waiting: early && view.freeFrom ? await countWaitingOrders(view.freeFrom) : 0 });
  } catch (error) {
    console.error('Error recording the arrival:', error);
    res.status(500).json({ message: 'Failed to record the arrival' });
  }
});

// POST /api/vehicle-planning/trips/expected-end - body { vehicleId, orderNumber, expectedEnd: 'YYYY-MM-DD' | null }: the planner stretched (or shrank) the bar.
// The response lists any trip that now starts before the vehicle is back, so the page can ask what to do with it. Notion's own trip days are never changed.
router.post('/vehicle-planning/trips/expected-end', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const vehicleId = Number(req.body?.vehicleId);
    const orderNumber = String(req.body?.orderNumber ?? '').trim();
    if (!vehicleId || !orderNumber) return res.status(400).json({ message: 'vehicleId and orderNumber are required' });
    const { history, entry } = await loadTrip(vehicleId, orderNumber);
    if (!entry) return res.status(404).json({ message: 'That trip is not on this vehicle.' });
    const { group, first } = tripEntries(history, orderNumber);
    const { userCode, userName } = who(req);
    const vehicle = await storage.getVehicleInfo(vehicleId);
    if (req.body?.expectedEnd == null) {
      for (const g of group) { g.expectedEnd = null; g.expectedEndByCode = null; g.expectedEndAt = null; g.expectedEndReason = null; }
    } else {
      const problem = checkExpectedEnd({ ...first, arrivedOn: group.find((g) => g.arrivedOn)?.arrivedOn ?? null }, req.body.expectedEnd);
      if (problem) return res.status(400).json({ message: problem });
      const newEnd = String(req.body.expectedEnd);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
      // Moving the last day LATER than it is now needs a reason (breakdown, waiting at the party...). Shortening, or going back to the plan, does not.
      const current = computeVehicleTrips(history).trips.find((t) => t.members.some((m) => m.orderNumber === orderNumber));
      const extending = !!current && newEnd > current.lastBusyDay;
      if (extending && reason.length < 3) return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Say why the trip is extended.' });
      for (const g of group) {
        g.expectedEndReason = reason || (extending ? null : g.expectedEndReason ?? null);
        g.expectedEnd = newEnd; g.expectedEndByCode = userCode ?? null; g.expectedEndAt = new Date().toISOString();
      }
    }
    await saveHistory(vehicleId, history);
    if (userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'update', entityType: 'vehicle_trip', entityId: orderNumber, details: `${vehicle?.vehicleNumber ?? vehicleId}: expected last day of order${group.length > 1 ? 's' : ''} ${group.map((g) => `#${g.orderNumber}`).join(', ')} ${group[0].expectedEnd ? `set to ${group[0].expectedEnd}${group[0].expectedEndReason ? ` (reason: ${group[0].expectedEndReason})` : ''}` : 'cleared (back to the planned end)'} by ${userName ?? userCode}`, userCode, userName });
    res.json(tripsView(history));
  } catch (error) {
    console.error('Error setting the expected end:', error);
    res.status(500).json({ message: 'Failed to set the expected end' });
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
    // A company the planner added beyond the two defaults (for example DUMMY) is listed in full, even for vehicles with no trips yet - they are the
    // reason it was chosen. The two default groups keep hiding no-trip vehicles unless the page's switch is on.
    const extraFilters = companyFilters.filter((f) => !DEFAULT_COMPANY_FILTERS.some((d) => d.toLowerCase() === f.toLowerCase()));
    const showAlwaysFor = (company: string | null | undefined) => extraFilters.length > 0 && qualifiesForVehiclePlanning(company, extraFilters);

    const { rows: stateRows } = await pool.query(
      `SELECT vehicle_id AS "vehicleId", order_history AS "orderHistory", last_synced_at AS "lastSyncedAt"
       FROM vehicle_planning_state WHERE vehicle_id = ANY($1)`,
      [fleet.map((v) => v.id)],
    );
    const stateByVehicleId = new Map(stateRows.map((r: any) => [r.vehicleId, r]));

    // Which orders Loading has taken over (Free is greyed out for them): our slip decides when we have one; an order that only exists in Notion is judged by
    // the status the last Refresh read.
    const orderNos = Array.from(new Set(stateRows.flatMap((r: any) => ((r.orderHistory ?? []) as VehiclePlanningOrderEntry[]).map((e) => e.orderNumber))));
    const lockSlips = orderNos.length ? (await pool.query(
      `SELECT order_number AS "orderNumber", dispatched_at AS "dispatchedAt", notion_status AS "notionStatus", loading_stv AS "loadingStv",
              loading_owner_code AS "loadingOwnerCode", loading_completed_at AS "loadingCompletedAt"
         FROM proforma_slips WHERE order_number = ANY($1::text[])`, [orderNos])).rows : [];
    const lockSlipByOrder = new Map<string, any>(lockSlips.map((s: any) => [s.orderNumber, s]));

    const rows = fleet.map((v) => {
      const state = stateByVehicleId.get(v.id);
      const history: VehiclePlanningOrderEntry[] = state?.orderHistory ?? [];
      // "Current" = the single most-recently-dated entry, regardless of status — same "latest
      // wins" rule the old live Notion fetch used (busy/free is a separate computed flag below).
      const currentOrder = history.length > 0
        ? history.reduce((latest, e) => (!latest || (e.orderDate ?? '') > (latest.orderDate ?? '') ? e : latest))
        : null;

      // Every trip with its state, the day the vehicle is free from, and any trip that starts before the vehicle is back.
      const vt = computeVehicleTrips(history);
      for (const tr of vt.trips) {
        tr.lockedReason = tr.members.map((m) => { const s = lockSlipByOrder.get(m.orderNumber); return s ? planningLock(s) : notionOnlyLock(m.status); }).find((x) => !!x) ?? null;
      }
      const tripFields = { trips: vt.trips, freeFrom: vt.freeFrom, vehicleState: vt.vehicleState, conflicts: vt.conflicts };

      if (!v.vehicleNumber || !currentOrder) {
        return {
          id: v.id, vehicleNumber: v.vehicleNumber ?? null, rtoNumber: v.rtoNumber, driver: v.driver,
          state: null, company: v.company, currentOrder: null, busy: false, busyUntil: null, tripDays: null,
          hasHistory: history.length > 0, showAlways: showAlwaysFor(v.company), lastSyncedAt: state?.lastSyncedAt ?? null, ...tripFields,
        };
      }

      // Busy follows the trip dates only (the arrival a person recorded, else the stretched end, else the planned end) - not Notion's status, which a
      // dispatcher does not always flip on time. A trip past its end with no arrival still counts as busy ("awaiting arrival").
      const busy = vt.vehicleState !== 'free';
      const busyUntil = busy && vt.freeFrom ? toDmy(addDays(vt.freeFrom, -1)) : null;
      // The bar still reads tripCompletesOn: give it the real last busy day of this trip (arrival / stretch / plan).
      const thisTrip = vt.trips.find((x) => x.members.some((m) => m.orderNumber === currentOrder.orderNumber));
      const tripCompletesOn = thisTrip ? toDmy(thisTrip.lastBusyDay) : currentOrder.tripCompletesOn;

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
          tripCompletesOn,
          vehicleMismatch: currentOrder.vehicleMismatch, mismatchProformaVehicleNumber: currentOrder.mismatchProformaVehicleNumber,
          notInSystem: !!currentOrder.notInSystem,
        },
        busy, busyUntil, tripDays: currentOrder.tripDays,
        hasHistory: true, showAlways: showAlwaysFor(v.company), lastSyncedAt: state?.lastSyncedAt ?? null, ...tripFields,
      };
    });

    // Day notes (the last 90 days and the next 270, the board's scroll range), grouped by vehicle.
    const { rows: noteRows } = await pool.query(
      `SELECT vehicle_id AS "vehicleId", day::text AS day, note AS text, created_by_name AS "byName", updated_at AS "at"
         FROM vehicle_planning_day_notes
        WHERE vehicle_id = ANY($1::int[]) AND day BETWEEN (CURRENT_DATE - 90) AND (CURRENT_DATE + 270) ORDER BY day`,
      [fleet.map((v) => v.id)],
    );
    const notesByVehicle = new Map<number, { day: string; text: string; byName: string | null; at: string }[]>();
    for (const n of noteRows as any[]) {
      if (!notesByVehicle.has(n.vehicleId)) notesByVehicle.set(n.vehicleId, []);
      notesByVehicle.get(n.vehicleId)!.push({ day: n.day, text: n.text, byName: n.byName ?? null, at: new Date(n.at).toISOString() });
    }
    // Vehicle status set on this page (maintenance, breakdown ...): our system only. A status with days blocks the vehicle for that many days from the day it was
    // set (the Available filter and the Assign button follow); with 0 days it is just a label. A status whose days are over is simply gone.
    const { rows: statusRows } = await pool.query(
      `SELECT vehicle_id AS "vehicleId", status, start_day::text AS "startDay", days, comment, set_by_name AS "byName" FROM vehicle_planning_status WHERE vehicle_id = ANY($1::int[])`,
      [fleet.map((v) => v.id)],
    );
    const todayStr = todayIst();
    const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
    const manualByVehicle = new Map<number, any>();
    for (const s of statusRows as any[]) {
      const endDay = s.days >= 1 ? addDays(s.startDay, s.days - 1) : null;
      if (endDay && endDay < todayStr) continue;
      const blocks = !!endDay && endDay >= todayStr;
      manualByVehicle.set(s.vehicleId, {
        status: s.status, startDay: s.startDay, days: s.days, endDay, blocks, comment: s.comment ?? null, byName: s.byName ?? null,
        daysLeft: blocks ? dayDiff(s.startDay > todayStr ? s.startDay : todayStr, endDay!) + 1 : null,
        availableFrom: blocks ? addDays(endDay!, 1) : null,
      });
    }
    const vehicleById = new Map(fleet.map((v) => [v.id, v] as const));
    const rowsWithNotes = rows.map((r) => ({
      ...r, dayNotes: notesByVehicle.get(r.id) ?? [],
      volume: vehicleById.get(r.id)?.volume ?? null, bodyType: vehicleById.get(r.id)?.bodyType ?? null,
      manualStatus: manualByVehicle.get(r.id) ?? null,
    }));

    // When the data was last read from Notion (the page shows it next to the Refresh button, since nothing refreshes it by itself).
    const lastRefreshedAt = stateRows.reduce((m: Date | null, r: any) => (r.lastSyncedAt && (!m || new Date(r.lastSyncedAt) > m) ? new Date(r.lastSyncedAt) : m), null as Date | null);
    res.json({ vehicles: rowsWithNotes, companyFilters, lastRefreshedAt: lastRefreshedAt ? lastRefreshedAt.toISOString() : null, planningStartDate: await getPlanningStartDate(), lastReset: await lastUndoableReset() });
  } catch (error) {
    console.error('Error building vehicle planning fleet view:', error);
    res.status(500).json({ message: 'Failed to load vehicle planning data' });
  }
});

// ─── Assign: what the dialog needs, and the assignment itself ──────────────────────────────────────────────────

const isAdminUser = (req: Request) => WRITE_ADMIN_ROLES.includes(String((req.user as any)?.role ?? '').toLowerCase());
const dayOf = (v: unknown) => String(v ?? '').slice(0, 10);
const WENT_OUT = new Set(['DISPATCHED', 'DELIVERED', 'UNLOADING', 'SHORTAGE']);

// Planning does not change a load that Loading has taken over: once loading has started or the slip has gone out, the Loading page is the place.
// An order that only exists in Notion (no slip here) has no Loading record, so the status the last Refresh read stands in: from LOADING onward the order is out of Planning's hands.
const NOTION_ONLY_LOCKED = new Set(['LOADING', 'READY≈DESP', 'DISPATCHED', 'UNLOADING', 'SHORTAGE', 'DELIVERED']);
function notionOnlyLock(status: string | null | undefined): string | null {
  const s = String(status ?? '').trim().toUpperCase();
  return NOTION_ONLY_LOCKED.has(s) ? `Notion already shows ${s} for this order, so its vehicle can no longer be changed here.` : null;
}

function planningLock(slip: any): string | null {
  if (slip.dispatchedAt || WENT_OUT.has(String(slip.notionStatus ?? '').trim().toUpperCase())) {
    return 'This order has already been dispatched. Change its vehicle on the Loading page.';
  }
  if (slip.loadingStv || slip.loadingOwnerCode || slip.loadingCompletedAt) {
    return 'Loading has already started for this order. Change its vehicle on the Loading page.';
  }
  return null;
}

async function loadHistory(vehicleId: number): Promise<VehiclePlanningOrderEntry[]> {
  const { rows } = await pool.query(`SELECT order_history AS "orderHistory" FROM vehicle_planning_state WHERE vehicle_id = $1`, [vehicleId]);
  return rows[0]?.orderHistory ?? [];
}

// The trip days the same party had on an earlier trip (any vehicle), newest first - used when Notion has no trip days for a new order.
async function partyEarlierTripDays(partyName: string | null | undefined): Promise<number | null> {
  if (!partyName) return null;
  const { rows } = await pool.query(
    `SELECT e->>'tripDays' AS d FROM vehicle_planning_state, jsonb_array_elements(order_history) e
      WHERE lower(e->>'partyName') = lower($1) AND (e->>'tripDays') ~ '^[0-9]+$' AND (e->>'tripDays')::int >= 1
      ORDER BY e->>'orderDate' DESC NULLS LAST LIMIT 1`,
    [partyName],
  );
  return rows[0] ? parseInt(rows[0].d, 10) : null;
}

// GET /api/vehicle-planning/available-orders?vehicleId=&date=YYYY-MM-DD&q=
// With a vehicleId the answer also says when that vehicle is free (the dialog opens on that day), who drove it last, and which unassigned orders from
// the free day up to 7 days ahead could go on it next (same plant first, nearest date first), each marked "fits" or "runs into #xxxx".
router.get('/vehicle-planning/available-orders', requirePageAccess('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const today = todayIst();
    const vehicleId = Number(req.query.vehicleId) || null;
    let freeFrom: string | null = null;
    let busyOrder: string | null = null;
    let lastDriver: string | null = null;
    let lastPlant: string | null = null;
    let upcoming: { orderNumber: string; startDay: string }[] = [];
    // The trips this vehicle is busy with (not arrived): a free order dated inside one of them can ride along as a shared load.
    let busyTrips: { orderNumber: string; partyName: string | null; startDay: string; freeFromDay: string }[] = [];
    if (vehicleId) {
      const vt = computeVehicleTrips(await loadHistory(vehicleId));
      freeFrom = vt.freeFrom;
      const live = vt.trips.filter((t) => t.state !== 'cancelled');
      busyOrder = live.length ? live.reduce((m, t) => (t.lastBusyDay > m.lastBusyDay ? t : m), live[0]).orderNumber : null;
      const latest = [...live].sort((a, b) => b.startDay.localeCompare(a.startDay))[0];
      lastDriver = [...live].sort((a, b) => b.startDay.localeCompare(a.startDay)).find((t) => t.driver)?.driver ?? null;
      lastPlant = latest?.plant ?? null;
      upcoming = live.filter((t) => t.state === 'planned' || t.state === 'on_trip').map((t) => ({ orderNumber: t.orderNumber, startDay: t.startDay }));
      busyTrips = live.filter((t) => !t.arrivedOn && (t.state === 'planned' || t.state === 'on_trip' || t.state === 'awaiting'))
        .map((t) => ({ orderNumber: t.orderNumber, partyName: t.members.map((m) => m.partyName).filter(Boolean).join(' + ') || null, startDay: t.startDay, freeFromDay: t.freeFromDay }));
      if (!lastDriver) lastDriver = (await storage.getVehicleInfo(vehicleId))?.driver ?? null;
    }
    const defaultDate = freeFrom && freeFrom > today ? freeFrom : today;
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : defaultDate;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const params: any[] = [date];
    let search = '';
    if (q) { params.push(`%${q}%`); search = ` AND (LOWER(order_number) LIKE $2 OR LOWER(COALESCE(party_name,'')) LIKE $2)`; }
    const { rows } = await pool.query(
      `SELECT order_number AS "orderNumber", party_name AS "partyName", plant,
              order_date::text AS "orderDate", vehicle_number AS "vehicleNumber",
              notion_status AS "notionStatus", driver_name AS "driverName"
       FROM proforma_slips
       WHERE (order_date AT TIME ZONE 'Asia/Kolkata')::date = $1::date${search}
         AND (vehicle_number IS NULL OR vehicle_number = '')
         AND UPPER(COALESCE(notion_status,'')) <> 'CANCELLED'
       ORDER BY order_number
       LIMIT 200`,
      params,
    );
    const orders = rows.map((o: any) => ({ ...o, beforeFree: !!freeFrom && dayOf(o.orderDate) < freeFrom }));

    let suggestions: any[] = [];
    if (vehicleId) {
      const from = defaultDate;
      const to = addDays(from, 7);
      const { rows: cand } = await pool.query(
        `SELECT order_number AS "orderNumber", party_name AS "partyName", plant, order_date::text AS "orderDate", notion_status AS "notionStatus"
           FROM proforma_slips
          WHERE (vehicle_number IS NULL OR vehicle_number = '')
            AND (order_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
            AND UPPER(COALESCE(notion_status,'')) <> 'CANCELLED'
          ORDER BY (COALESCE(plant,'') = COALESCE($3,'')) DESC, order_date, order_number
          LIMIT 40`,
        [from, to, lastPlant ?? ''],
      );
      const daysByParty = new Map<string, number | null>();
      suggestions = [];
      for (const c of cand) {
        const key = String(c.partyName ?? '').toLowerCase();
        if (!daysByParty.has(key)) daysByParty.set(key, await partyEarlierTripDays(c.partyName));
        const days = daysByParty.get(key) ?? 1;
        const start = dayOf(c.orderDate);
        const end = addDays(start, days - 1);
        const next = upcoming.filter((u) => u.startDay > start).sort((a, b) => a.startDay.localeCompare(b.startDay))[0];
        const runsInto = next && end >= next.startDay ? next.orderNumber : null;
        suggestions.push({ ...c, tripDaysGuess: days, samePlant: !!lastPlant && c.plant === lastPlant, fits: !runsInto, runsInto });
      }
    }
    // Free orders dated on days this vehicle is already busy: offered as "add to that trip" (a shared load), each with the trip it would join.
    const sharable: any[] = [];
    if (busyTrips.length) {
      const from = busyTrips.reduce((m, t) => (t.startDay < m ? t.startDay : m), busyTrips[0].startDay);
      const to = addDays(busyTrips.reduce((m, t) => (t.freeFromDay > m ? t.freeFromDay : m), busyTrips[0].freeFromDay), -1);
      if (to >= from) {
        const { rows: cand } = await pool.query(
          `SELECT order_number AS "orderNumber", party_name AS "partyName", plant, order_date::text AS "orderDate"
             FROM proforma_slips
            WHERE (vehicle_number IS NULL OR vehicle_number = '')
              AND (order_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
              AND UPPER(COALESCE(notion_status,'')) <> 'CANCELLED'
            ORDER BY order_date, order_number LIMIT 60`,
          [from, to],
        );
        for (const c of cand) {
          const d = dayOf(c.orderDate);
          const trip = busyTrips.find((t) => t.startDay <= d && d < t.freeFromDay);
          if (trip) sharable.push({ ...c, joinOrder: trip.orderNumber, joinParty: trip.partyName });
        }
      }
    }
    res.json({
      orders, date, sharable,
      vehicle: vehicleId ? { freeFrom, busyUntil: freeFrom ? addDays(freeFrom, -1) : null, busyOrder, lastDriver, lastPlant } : null,
      suggestions,
    });
  } catch (error) {
    console.error('Error listing available orders for vehicle planning:', error);
    res.status(500).json({ message: 'Failed to load available orders' });
  }
});

// GET /api/vehicle-planning/drivers - the Notion driver list (name + page id) for the driver box. Read on request, cached for a few minutes.
router.get('/vehicle-planning/drivers', requirePageAccess('vehicle-planning'), async (_req: Request, res: Response) => {
  try {
    res.json({ drivers: await listNotionDrivers() });
  } catch (error) {
    res.json({ drivers: [], message: 'Could not read the driver list from Notion. Type the driver name instead.' });
  }
});

// GET /api/vehicle-planning/order-driver?orderNumber= - the driver (and trip days) Notion already has on this order.
router.get('/vehicle-planning/order-driver', requirePageAccess('vehicle-planning'), async (req: Request, res: Response) => {
  const orderNumber = String(req.query.orderNumber ?? '').trim();
  if (!orderNumber) return res.status(400).json({ message: 'orderNumber is required' });
  const info = await readNotionOrderInfo(orderNumber);
  if (!info) return res.json({ found: false, driver: null, tripDays: null, message: 'Notion could not be reached, or has no such order.' });
  res.json({ found: true, driver: info.driver, tripDays: info.tripDays });
});

// Sets the "Notion not updated" note on a trip from the outcome of a push, so the board can show it and offer Retry.
async function noteNotionOutcome(vehicleId: number, orderNumber: string, outcome: NotionSyncOutcome) {
  const { history, entry } = await loadTrip(vehicleId, orderNumber);
  if (!entry) return;
  entry.notionNote = outcome.state === 'failed' || outcome.state === 'retrying' ? outcome.message : null;
  await saveHistory(vehicleId, history);
}

// How many unassigned orders could go on a vehicle that just became free from `freeFrom` (the early-arrival "N orders are waiting" message).
async function countWaitingOrders(freeFrom: string): Promise<number> {
  const today = todayIst();
  const from = freeFrom > today ? freeFrom : today;
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM proforma_slips
      WHERE (vehicle_number IS NULL OR vehicle_number = '')
        AND (order_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
        AND UPPER(COALESCE(notion_status,'')) <> 'CANCELLED'`,
    [from, addDays(from, 7)],
  );
  return rows[0]?.n ?? 0;
}

// Takes an order out of a vehicle's history. When it was the PRIMARY of a shared load, the next order of that trip becomes the primary and keeps what was
// recorded on the trip (arrival, same-day tick, expected end), so the other orders stay together.
function removeFromHistory(history: VehiclePlanningOrderEntry[], orderNumber: string): VehiclePlanningOrderEntry[] {
  const leaving = history.find((e) => e.orderNumber === orderNumber);
  const rest = history.filter((e) => e.orderNumber !== orderNumber);
  if (!leaving) return rest;
  const followers = rest.filter((e) => e.sameTripAs === orderNumber);
  if (followers.length === 0) return rest;
  const next = [...followers].sort((a, b) => String(a.orderDate ?? '').localeCompare(String(b.orderDate ?? '')))[0];
  for (const k of ['arrivedOn', 'arrivedByCode', 'arrivedByName', 'arrivedAt', 'arrivalNote', 'freeSameDay', 'expectedEnd', 'expectedEndByCode', 'expectedEndAt', 'expectedEndReason'] as const) {
    if ((next as any)[k] == null && (leaving as any)[k] != null) (next as any)[k] = (leaving as any)[k];
  }
  next.sameTripAs = leaving.sameTripAs ?? null;
  for (const f of followers) if (f !== next) f.sameTripAs = next.orderNumber;
  return rest;
}

type AssignInput = { orderNumber: string; vehicleId: number; driverName?: string | null; driverPageId?: string | null; force?: boolean; sameTripAs?: string | null; move?: boolean };
type AssignActor = { userCode?: string; userName?: string; isAdmin: boolean };

// The whole assignment, as a function so "Move all" can run it once per order of a shared trip.
// Order of work: the date rule -> our slip first (vehicle, driver, who) -> the vehicle's history trip (trip days: Notion, else the party's earlier trip, else 1)
// -> Notion (vehicle + driver; retried in the background) -> an Activities line. A slip that was on another vehicle leaves that vehicle's history.
async function performAssign(inp: AssignInput, actor: AssignActor): Promise<{ status: number; body: any }> {
  const { orderNumber, vehicleId } = inp;
  const fail = (status: number, body: any) => ({ status, body });
  // Only a slip that is already in our system can be assigned - Vehicle Planning never creates one.
  const slip = await storage.getProformaSlipByOrderNumber(orderNumber);
  if (!slip) return fail(404, { message: `Order ${orderNumber} is not in our system. Add its slip first, then assign the vehicle.` });

  const vehicle = await storage.getVehicleInfo(vehicleId);
  if (!vehicle) return fail(404, { message: 'Vehicle not found' });
  if (!vehicle.vehicleNumber) return fail(400, { message: 'This vehicle has no vehicle number set in Vehicle Master.' });

  // One slip, one vehicle (a vehicle may hold many slips): an order whose SLIP already has another vehicle is not taken over by a plain assign. Free it there first,
  // or move it on purpose (Change -> Move, which sends `move`). Only the slip counts: a copy of the order that an old Refresh left on some board (Notion-only) does not.
  if (!inp.move) {
    const onOtherSlip = (!!slip.vehicleInfoId && slip.vehicleInfoId !== vehicle.id) || (!!slip.vehicleNumber && slip.vehicleNumber !== vehicle.vehicleNumber);
    if (onOtherSlip) {
      return fail(409, { code: 'ALREADY_ASSIGNED', message: `Order #${orderNumber} is already on ${slip.vehicleNumber ?? 'another vehicle'}. An order can be on only one vehicle: free it there first, or use Change → Move.` });
    }
  }

  const { userCode, userName } = actor;
  const previousVehicleId = slip.vehicleInfoId ?? null;
  const movingVehicle = !!slip.vehicleNumber && (previousVehicleId !== vehicle.id || slip.vehicleNumber !== vehicle.vehicleNumber);
  if (movingVehicle) {
    const locked = planningLock(slip);
    if (locked) return fail(409, { code: 'LOCKED', message: locked });
  }

  const orderDay = dayOf(slip.orderDate);
  const history = await loadHistory(vehicle.id);
  const others = history.filter((e) => e.orderNumber !== orderNumber);

  // A SHARED load: this order rides an existing trip of this vehicle, so the date rule does not apply to it.
  let joinPrimary: string | null = null;
  if (inp.sameTripAs) {
    if (inp.sameTripAs === orderNumber || !others.some((e) => e.orderNumber === inp.sameTripAs)) return fail(400, { message: `Order ${inp.sameTripAs} is not on this vehicle, so it cannot share its trip.` });
    joinPrimary = groupPrimaryOf(others, inp.sameTripAs);
    const target = computeVehicleTrips(others).trips.find((t) => t.orderNumber === joinPrimary);
    const alreadyMember = history.find((e) => e.orderNumber === orderNumber)?.sameTripAs === joinPrimary;
    if (!alreadyMember && target && (target.state === 'arrived' || target.state === 'closed')) return fail(409, { message: `That trip has already arrived, so another order cannot join it.` });
  }

  // 1. The date rule: an order cannot start before the vehicle is back. An admin may still do it, after confirming.
  const vt = computeVehicleTrips(others);
  const early = !joinPrimary && !!vt.freeFrom && !!orderDay && orderDay < vt.freeFrom;
  if (early) {
    if (!inp.force) {
      const live = vt.trips.filter((t) => t.state !== 'cancelled');
      const holder = live.reduce((m, t) => (t.freeFromDay > m.freeFromDay ? t : m), live[0]);
      const today = todayIst();
      const overlapping = live
        .filter((t) => (t.state === 'planned' || t.state === 'on_trip' || t.state === 'awaiting') && t.startDay <= orderDay && orderDay <= t.lastBusyDay)
        .map((t) => ({ orderNumber: t.orderNumber, partyName: t.members.map((m) => m.partyName).filter(Boolean).join(' + ') || null }));
      // The trip holding the vehicle could simply be marked arrived (it has ended or ends today, nothing recorded): offered as "Mark arrived and assign".
      const suggested = holder.lastBusyDay <= today ? holder.lastBusyDay : today;
      const canMarkArrived = !holder.arrivedOn && (holder.state === 'on_trip' || holder.state === 'awaiting') && suggested >= holder.startDay && suggested <= today && orderDay >= suggested;
      return fail(409, {
        code: 'BEFORE_FREE', freeFrom: vt.freeFrom, busyOrder: holder?.orderNumber ?? null, overlapping,
        blocking: holder ? { orderNumber: holder.orderNumber, partyName: holder.members.map((m) => m.partyName).filter(Boolean).join(' + ') || null, suggestedArrival: suggested, canMarkArrived } : null,
        message: `${vehicle.vehicleNumber} is busy until ${toDmy(addDays(vt.freeFrom!, -1))}${holder ? ` (order #${holder.orderNumber})` : ''}. This order starts ${toDmy(orderDay)}.`,
      });
    }
    if (!actor.isAdmin) return fail(403, { message: 'Only an admin can assign a vehicle before it is free.' });
  }

  // 2. Our slip first.
  const driverName = typeof inp.driverName === 'string' ? inp.driverName.trim() : null;
  const driverPageId = typeof inp.driverPageId === 'string' && inp.driverPageId ? inp.driverPageId : null;
  const updated = await storage.updateProformaSlip(slip.id, {
    vehicleNumber: vehicle.vehicleNumber,
    vehicleInfoId: vehicle.id,
    vehicleAssignedByCode: userCode ?? null,
    ...(driverName ? { driverName } : {}),
  } as any);
  if (!updated) return fail(500, { message: 'Failed to assign vehicle' });

  // 3. The vehicle's history: leave the old vehicle, trip days, then the trip itself.
  if (previousVehicleId && previousVehicleId !== vehicle.id) {
    const oldHistory = await loadHistory(previousVehicleId);
    if (oldHistory.some((e) => e.orderNumber === orderNumber)) await saveHistory(previousVehicleId, removeFromHistory(oldHistory, orderNumber));
  }
  const existing = history.find((e) => e.orderNumber === orderNumber);
  let tripDays = parseInt(String(existing?.tripDays ?? ''), 10);
  let tripDaysSource = 'kept';
  if (!(tripDays >= 1)) {
    const notionInfo = await readNotionOrderInfo(orderNumber);
    if (notionInfo?.tripDays) { tripDays = notionInfo.tripDays; tripDaysSource = 'Notion'; }
    else {
      const earlier = await partyEarlierTripDays(updated.partyName);
      if (earlier) { tripDays = earlier; tripDaysSource = "the party's earlier trip"; }
      else { tripDays = 1; tripDaysSource = 'default (1 day)'; }
    }
  }
  const start = dayOf(updated.orderDate);
  await upsertHistoryEntry(vehicle.id, {
    orderNumber,
    proformaSlipId: updated.id,
    orderDate: start || null,
    status: updated.notionStatus ?? null,
    driver: driverName || updated.driverName || existing?.driver || null,
    driverNotionId: driverPageId ?? existing?.driverNotionId ?? null,
    tripCompletesOn: start ? toDmy(addDays(start, tripDays - 1)) : null,
    tripDays: String(tripDays),
    partyName: updated.partyName ?? null,
    plant: updated.plant ?? null,
    state: existing?.state ?? null,
    vehicleMismatch: false,
    mismatchProformaVehicleNumber: null,
    notInSystem: false,
    actualCompletedAt: existing?.actualCompletedAt ?? null,
    ...(joinPrimary ? { sameTripAs: joinPrimary } : {}),
  });

  // 4. Notion - "Vehi  No. :" and "Driver :" are RELATIONS (to the vehicle's / driver's own Notion page). Compare, write, read back, retry every 2 minutes
  // up to 5 tries (see notionOrderStatusSync.ts). The slip above already holds the assignment, so a Notion hiccup is reported, not thrown.
  const notionOutcome: NotionSyncOutcome = vehicle.notionPageId
    ? await settleNotionSync(syncOrderToNotion(orderNumber, { vehiclePageId: vehicle.notionPageId, ...(driverPageId ? { driverPageId } : {}) }, { userCode }))
    : { state: 'skipped', message: `${vehicle.vehicleNumber} has no Notion page, so Notion was not updated with this vehicle.` };
  await noteNotionOutcome(vehicle.id, orderNumber, notionOutcome);
  // Notion's automation may change the status after a vehicle is set - two minutes from now the status of a load started in the app is put back.
  void watchStatusAfterVehicleChange(orderNumber, { userCode });

  // 5. Activities.
  if (userCode) {
    await storage.logActivity({
      pageName: 'Vehicle Planning', action: 'update', entityType: 'vehicle_assignment', entityId: orderNumber,
      details: `${vehicle.vehicleNumber} assigned to order #${orderNumber}${driverName ? ` with driver ${driverName}` : ''} by ${userName ?? userCode}`
        + `${slip.vehicleNumber && slip.vehicleNumber !== vehicle.vehicleNumber ? ` (was on ${slip.vehicleNumber})` : ''}`
        + `${joinPrimary ? ` as a shared load with order #${joinPrimary}` : ''}`
        + `${early ? ` - assigned before the vehicle was free (${toDmy(vt.freeFrom!)}), admin override` : ''}; trip days ${tripDays} (${tripDaysSource}); Notion: ${notionOutcome.state}`,
      userCode, userName,
    });
  }

  const after = tripsView(await loadHistory(vehicle.id));
  return { status: 200, body: { slip: updated, notion: notionOutcome, tripDays, tripDaysSource, early, sharedWith: joinPrimary, ...after } };
}

// POST /api/vehicle-planning/assign - body { orderNumber, vehicleId, driverName?, driverPageId?, force?, sameTripAs? }
router.post('/vehicle-planning/assign', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const orderNumber = String(req.body?.orderNumber ?? '').trim();
    const vehicleId = req.body?.vehicleId != null ? Number(req.body.vehicleId) : null;
    if (!orderNumber || !vehicleId) return res.status(400).json({ message: 'orderNumber and vehicleId are required' });
    const r = await performAssign({
      orderNumber, vehicleId, driverName: req.body?.driverName, driverPageId: req.body?.driverPageId, force: !!req.body?.force,
      sameTripAs: typeof req.body?.sameTripAs === 'string' && req.body.sameTripAs.trim() ? req.body.sameTripAs.trim() : null,
      move: !!req.body?.move,
    }, { ...who(req), isAdmin: isAdminUser(req) });
    res.status(r.status).json(r.body);
  } catch (error) {
    console.error('Error assigning vehicle from vehicle planning:', error);
    res.status(500).json({ message: 'Failed to assign vehicle' });
  }
});

// POST /api/vehicle-planning/trips/move-group - body { vehicleId, orderNumber, toVehicleId, force? }: a shared trip (all its orders) moves to another vehicle together.
router.post('/vehicle-planning/trips/move-group', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const vehicleId = Number(req.body?.vehicleId);
    const toVehicleId = Number(req.body?.toVehicleId);
    const orderNumber = String(req.body?.orderNumber ?? '').trim();
    if (!vehicleId || !toVehicleId || !orderNumber) return res.status(400).json({ message: 'vehicleId, orderNumber and toVehicleId are required' });
    const history = await loadHistory(vehicleId);
    const members = groupEntries(history, orderNumber);
    if (members.length === 0) return res.status(404).json({ message: 'That trip is not on this vehicle.' });
    // Either order started loading or went out: the whole trip stays where it is.
    for (const m of members) {
      const sl = await storage.getProformaSlipByOrderNumber(m.orderNumber);
      const locked = sl ? planningLock(sl) : null;
      if (locked) return res.status(409).json({ code: 'LOCKED', message: `Order ${m.orderNumber}: ${locked}` });
    }
    const primary = groupPrimaryOf(history, orderNumber);
    const ordered = [...members].sort((a, b) => Number(b.orderNumber === primary) - Number(a.orderNumber === primary));
    const actor = { ...who(req), isAdmin: isAdminUser(req) };
    // The primary is checked against the new vehicle's dates first (and may ask the planner); the others then ride along with it.
    let last: { status: number; body: any } = { status: 200, body: {} };
    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i];
      last = await performAssign({ orderNumber: m.orderNumber, vehicleId: toVehicleId, driverName: m.driver, driverPageId: m.driverNotionId, force: !!req.body?.force, sameTripAs: i === 0 ? null : primary, move: true }, actor);
      if (last.status !== 200) {
        // Not the first? Put the ones already moved back so the trip is not split across two vehicles.
        for (let k = 0; k < i; k++) await performAssign({ orderNumber: ordered[k].orderNumber, vehicleId, driverName: ordered[k].driver, driverPageId: ordered[k].driverNotionId, force: true, sameTripAs: k === 0 ? null : primary, move: true }, { ...actor, isAdmin: true }).catch(() => null);
        return res.status(last.status).json(last.body);
      }
    }
    res.json({ ...last.body, moved: ordered.map((m) => m.orderNumber) });
  } catch (error) {
    console.error('Error moving a shared trip:', error);
    res.status(500).json({ message: 'Failed to move the trip' });
  }
});

// ─── Change plan: the driver of a trip, and taking the vehicle off an order ─────────────────────────────────────────
// (Moving a trip to another vehicle is /assign with the new vehicle: it leaves the old vehicle's history and replaces the vehicle in Notion.)

// Finds the slip(s) behind a trip and refuses when Loading has taken the order over. `whole` = every order of a shared trip (a driver change, a move of the whole
// trip); otherwise just that order. Sends the reply itself and returns null on a refusal.
async function slipsForChange(res: Response, vehicleId: number, orderNumber: string, whole: boolean) {
  const { history, entry } = await loadTrip(vehicleId, orderNumber);
  if (!entry) { res.status(404).json({ message: 'That trip is not on this vehicle.' }); return null; }
  const orders = whole ? groupEntries(history, orderNumber).map((e) => e.orderNumber) : [orderNumber];
  const slips: any[] = [];
  for (const no of orders) {
    const slip = await storage.getProformaSlipByOrderNumber(no);
    if (!slip) { res.status(404).json({ message: `Order ${no} is not in our system, so it cannot be changed here.` }); return null; }
    const locked = planningLock(slip);
    if (locked) { res.status(409).json({ code: 'LOCKED', message: orders.length > 1 ? `Order ${no}: ${locked}` : locked }); return null; }
    slips.push(slip);
  }
  return slips;
}

// POST /api/vehicle-planning/trips/driver - body { vehicleId, orderNumber, driverName, driverPageId? }. An empty driverName clears the driver.
// A shared trip has ONE driver, so every order of the trip changes together.
router.post('/vehicle-planning/trips/driver', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const vehicleId = Number(req.body?.vehicleId);
    const orderNumber = String(req.body?.orderNumber ?? '').trim();
    if (!vehicleId || !orderNumber) return res.status(400).json({ message: 'vehicleId and orderNumber are required' });
    const slips = await slipsForChange(res, vehicleId, orderNumber, true);
    if (!slips) return;
    const driverName = typeof req.body?.driverName === 'string' ? req.body.driverName.trim() : '';
    const driverPageId = typeof req.body?.driverPageId === 'string' && req.body.driverPageId ? req.body.driverPageId : null;
    const { userCode, userName } = who(req);
    const vehicle = await storage.getVehicleInfo(vehicleId);

    let outcome: NotionSyncOutcome = { state: 'ok', message: 'Notion is up to date.' };
    for (const slip of slips) {
      await storage.updateProformaSlip(slip.id, { driverName: driverName || null } as any);
      const { history, entry } = await loadTrip(vehicleId, slip.orderNumber);
      entry!.driver = driverName || null;
      entry!.driverNotionId = driverName ? driverPageId : null;
      await saveHistory(vehicleId, history);
      const o: NotionSyncOutcome = await settleNotionSync(syncOrderToNotion(slip.orderNumber, driverName ? (driverPageId ? { driverPageId } : {}) : { clearDriver: true }, { userCode }));
      await noteNotionOutcome(vehicleId, slip.orderNumber, o);
      if (o.state === 'failed' || o.state === 'retrying' || outcome.state === 'ok') outcome = o;
    }
    if (userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'update', entityType: 'vehicle_assignment', entityId: orderNumber, details: `Driver of order${slips.length > 1 ? 's' : ''} ${slips.map((s) => `#${s.orderNumber}`).join(', ')} (${vehicle?.vehicleNumber ?? vehicleId}) ${driverName ? `changed to ${driverName}` : 'removed'} by ${userName ?? userCode}; Notion: ${outcome.state}`, userCode, userName });
    res.json({ notion: outcome, ...tripsView(await loadHistory(vehicleId)) });
  } catch (error) {
    console.error('Error changing the driver from vehicle planning:', error);
    res.status(500).json({ message: 'Failed to change the driver' });
  }
});

// POST /api/vehicle-planning/trips/remove-vehicle - body { vehicleId, orderNumber }: this ONE order goes back to "no vehicle" (the other orders of a shared trip stay).
// The vehicle AND the driver are cleared on our slip and in Notion, and the order leaves the vehicle's history.
router.post('/vehicle-planning/trips/remove-vehicle', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const vehicleId = Number(req.body?.vehicleId);
    const orderNumber = String(req.body?.orderNumber ?? '').trim();
    if (!vehicleId || !orderNumber) return res.status(400).json({ message: 'vehicleId and orderNumber are required' });
    const { history, entry } = await loadTrip(vehicleId, orderNumber);
    if (!entry) return res.status(404).json({ message: 'That trip is not on this vehicle.' });
    // An order that only exists in Notion has no slip here: it is judged by the status the last Refresh read, and only the board and Notion change.
    const slip = await storage.getProformaSlipByOrderNumber(orderNumber);
    const locked = slip ? planningLock(slip) : notionOnlyLock(entry.status);
    if (locked) return res.status(409).json({ code: 'LOCKED', message: locked });
    const { userCode, userName } = who(req);
    const vehicle = await storage.getVehicleInfo(vehicleId);

    if (slip) await storage.updateProformaSlip(slip.id, { vehicleNumber: null, vehicleInfoId: null, vehicleAssignedByCode: null, driverName: null } as any);
    await saveHistory(vehicleId, removeFromHistory(history, orderNumber));
    const outcome: NotionSyncOutcome = await settleNotionSync(syncOrderToNotion(orderNumber, { clearVehicle: true, clearDriver: true }, { userCode }));
    void watchStatusAfterVehicleChange(orderNumber, { userCode });
    if (userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'update', entityType: 'vehicle_assignment', entityId: orderNumber, details: `${vehicle?.vehicleNumber ?? vehicleId} removed from order #${orderNumber} (vehicle and driver cleared${slip ? '' : '; order not in our system'}) by ${userName ?? userCode}; Notion: ${outcome.state}`, userCode, userName });
    res.json({ notion: outcome, notionFailed: outcome.state === 'failed' || outcome.state === 'retrying', ...tripsView(await loadHistory(vehicleId)) });
  } catch (error) {
    console.error('Error removing the vehicle from vehicle planning:', error);
    res.status(500).json({ message: 'Failed to remove the vehicle' });
  }
});

// POST /api/vehicle-planning/retry-notion - body { orderNumber }: push the vehicle and driver our slip holds to Notion again.
router.post('/vehicle-planning/retry-notion', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    const orderNumber = String(req.body?.orderNumber ?? '').trim();
    if (!orderNumber) return res.status(400).json({ message: 'orderNumber is required' });
    const slip = await storage.getProformaSlipByOrderNumber(orderNumber);
    if (!slip?.vehicleInfoId) return res.status(404).json({ message: 'This order has no vehicle in our system.' });
    const vehicle = await storage.getVehicleInfo(slip.vehicleInfoId);
    if (!vehicle) return res.status(404).json({ message: 'Vehicle not found' });
    const { entry } = await loadTrip(vehicle.id, orderNumber);
    const { userCode } = who(req);
    const outcome: NotionSyncOutcome = vehicle.notionPageId
      ? await settleNotionSync(syncOrderToNotion(orderNumber, { vehiclePageId: vehicle.notionPageId, ...(entry?.driverNotionId ? { driverPageId: entry.driverNotionId } : {}) }, { userCode }))
      : { state: 'skipped', message: `${vehicle.vehicleNumber} has no Notion page, so Notion was not updated with this vehicle.` };
    await noteNotionOutcome(vehicle.id, orderNumber, outcome);
    res.json({ notion: outcome });
  } catch (error) {
    console.error('Error retrying the Notion update:', error);
    res.status(500).json({ message: 'Failed to retry the Notion update' });
  }
});

// ─── Reset planning: clear our planning board and start again from a day (our system only - Notion is never touched) ─────────────────────────────────────

const RESET_UNDO_DAYS = 7;

async function getPlanningStartDate(): Promise<string | null> {
  const { rows } = await pool.query(`SELECT planning_start_date::text AS d FROM vehicle_planning_settings ORDER BY id LIMIT 1`);
  return rows[0]?.d ?? null;
}
async function setPlanningStartDate(day: string | null): Promise<void> {
  const updated = await pool.query(`UPDATE vehicle_planning_settings SET planning_start_date = $1 WHERE id = (SELECT id FROM vehicle_planning_settings ORDER BY id LIMIT 1)`, [day]);
  if (!updated.rowCount) await pool.query(`INSERT INTO vehicle_planning_settings (planning_start_date) VALUES ($1)`, [day]);
}

// What a reset would clear for the vehicles in the selected companies. Trips whose slip has gone out or started loading (planningLock) stay: Loading depends on their
// vehicle. A shared load is kept or cleared as a whole.
async function buildResetPlan() {
  const companyFilters = await getCompanyFilters();
  const fleet = (await storage.getAllVehicleInfo()).filter((v) => qualifiesForVehiclePlanning(v.company, companyFilters));
  const byId = new Map(fleet.map((v) => [v.id, v] as const));
  const { rows } = await pool.query(
    `SELECT vehicle_id AS "vehicleId", order_history AS "orderHistory" FROM vehicle_planning_state WHERE vehicle_id = ANY($1::int[]) AND jsonb_array_length(order_history) > 0`,
    [fleet.map((v) => v.id)],
  );
  const orderNumbers = Array.from(new Set(rows.flatMap((r: any) => (r.orderHistory as VehiclePlanningOrderEntry[]).map((e) => e.orderNumber))));
  const slipByOrder = new Map<string, any>();
  await mapWithConcurrency(orderNumbers, 8, async (no) => { const s = await storage.getProformaSlipByOrderNumber(no); if (s) slipByOrder.set(no, s); });

  const vehicles: Array<{ vehicleId: number; vehicleNumber: string | null; history: VehiclePlanningOrderEntry[]; keep: VehiclePlanningOrderEntry[]; clearTrips: number; clearEntries: VehiclePlanningOrderEntry[] }> = [];
  const slipClears: Array<{ id: number; orderNumber: string; vehicleId: number; vehicleNumber: string | null; vehicleInfoId: number | null; vehicleAssignedByCode: string | null; driverName: string | null }> = [];
  const kept: Array<{ orderNumber: string; vehicleNumber: string | null; reason: string }> = [];
  for (const r of rows as any[]) {
    const vehicle = byId.get(r.vehicleId);
    const history: VehiclePlanningOrderEntry[] = r.orderHistory;
    const groups = new Map<string, VehiclePlanningOrderEntry[]>();
    for (const e of history) { const k = groupPrimaryOf(history, e.orderNumber); (groups.get(k) ?? groups.set(k, []).get(k)!).push(e); }
    const keep: VehiclePlanningOrderEntry[] = [];
    const clearEntries: VehiclePlanningOrderEntry[] = [];
    let clearTrips = 0;
    for (const members of groups.values()) {
      const lock = members.map((m) => ({ m, why: slipByOrder.has(m.orderNumber) ? planningLock(slipByOrder.get(m.orderNumber)) : null })).find((x) => x.why);
      if (lock) {
        keep.push(...members);
        kept.push({ orderNumber: lock.m.orderNumber, vehicleNumber: vehicle?.vehicleNumber ?? null, reason: lock.why! });
      } else {
        clearEntries.push(...members);
        clearTrips++;
        for (const m of members) {
          const slip = slipByOrder.get(m.orderNumber);
          // Only a slip that really carries THIS vehicle loses it (a slip moved to another vehicle by Loading is left alone).
          if (slip && slip.vehicleInfoId === r.vehicleId) {
            slipClears.push({ id: slip.id, orderNumber: m.orderNumber, vehicleId: r.vehicleId, vehicleNumber: slip.vehicleNumber ?? null, vehicleInfoId: slip.vehicleInfoId ?? null, vehicleAssignedByCode: slip.vehicleAssignedByCode ?? null, driverName: slip.driverName ?? null });
          }
        }
      }
    }
    vehicles.push({ vehicleId: r.vehicleId, vehicleNumber: vehicle?.vehicleNumber ?? null, history, keep, clearTrips, clearEntries });
  }
  return { companyFilters, vehicles, slipClears, kept };
}

// GET /api/vehicle-planning/reset/preview - admin: the counts the Reset dialog shows. Writes nothing.
router.get('/vehicle-planning/reset/preview', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    if (!isAdminUser(req)) return res.status(403).json({ message: 'Only an admin can reset planning.' });
    const plan = await buildResetPlan();
    res.json({
      companyFilters: plan.companyFilters,
      vehiclesWithTrips: plan.vehicles.filter((v) => v.clearEntries.length > 0).length,
      trips: plan.vehicles.reduce((n, v) => n + v.clearTrips, 0),
      slipsToClear: plan.slipClears.length,
      kept: plan.kept.slice(0, 50),
      keptCount: plan.kept.length,
      currentStartDate: await getPlanningStartDate(),
      today: todayIst(),
    });
  } catch (error) {
    console.error('Error previewing the planning reset:', error);
    res.status(500).json({ message: 'Failed to prepare the reset' });
  }
});

// POST /api/vehicle-planning/reset - body { startDate: 'YYYY-MM-DD', confirm: 'RESET' } - admin. Copies what it clears (so Undo can bring it back), empties the planning board of the
// vehicles in the selected companies, takes the vehicle and driver off their slips in OUR system, and saves the start day. Nothing is sent to Notion.
router.post('/vehicle-planning/reset', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    if (!isAdminUser(req)) return res.status(403).json({ message: 'Only an admin can reset planning.' });
    if (String(req.body?.confirm ?? '').trim().toUpperCase() !== 'RESET') return res.status(400).json({ message: 'Type RESET to confirm.' });
    const startDate = String(req.body?.startDate ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return res.status(400).json({ message: 'Pick the day to start fresh from.' });

    const plan = await buildResetPlan();
    const affected = plan.vehicles.filter((v) => v.clearEntries.length > 0);
    const { userCode, userName } = who(req);
    const previousStart = await getPlanningStartDate();

    await client.query('BEGIN');
    const backup = await client.query(
      `INSERT INTO vehicle_planning_reset_backup (created_by_code, created_by_name, start_date, previous_start_date, company_filters, vehicles, slips)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userCode ?? null, userName ?? null, startDate, previousStart, JSON.stringify(plan.companyFilters),
       JSON.stringify(affected.map((v) => ({ vehicleId: v.vehicleId, history: v.history }))), JSON.stringify(plan.slipClears)],
    );
    for (const v of affected) {
      await client.query(`UPDATE vehicle_planning_state SET order_history = $1 WHERE vehicle_id = $2`, [JSON.stringify(v.keep), v.vehicleId]);
    }
    if (plan.slipClears.length > 0) {
      await client.query(
        `UPDATE proforma_slips SET vehicle_number = NULL, vehicle_info_id = NULL, vehicle_assigned_by_code = NULL, driver_name = NULL WHERE id = ANY($1::int[])`,
        [plan.slipClears.map((s) => s.id)],
      );
    }
    const updated = await client.query(`UPDATE vehicle_planning_settings SET planning_start_date = $1 WHERE id = (SELECT id FROM vehicle_planning_settings ORDER BY id LIMIT 1)`, [startDate]);
    if (!updated.rowCount) await client.query(`INSERT INTO vehicle_planning_settings (planning_start_date) VALUES ($1)`, [startDate]);
    await client.query('COMMIT');

    const trips = plan.vehicles.reduce((n, v) => n + v.clearTrips, 0);
    if (userCode) {
      await storage.logActivity({
        pageName: 'Vehicle Planning', action: 'update', entityType: 'planning_reset', entityId: String(backup.rows[0].id),
        details: `Planning reset by ${userName ?? userCode} (our system only, Notion not changed): ${trips} trip(s) cleared on ${affected.length} vehicle(s), ${plan.slipClears.length} slip(s) lost their vehicle and driver, ${plan.kept.length} kept (gone out or loading); start fresh from ${startDate}`,
        userCode, userName,
      });
    }
    res.json({ resetId: backup.rows[0].id, vehiclesCleared: affected.length, trips, slipsCleared: plan.slipClears.length, kept: plan.kept.slice(0, 50), keptCount: plan.kept.length, startDate });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error resetting vehicle planning:', error);
    res.status(500).json({ message: 'Failed to reset planning' });
  } finally {
    client.release();
  }
});

// The last reset that can still be undone (not undone yet, within RESET_UNDO_DAYS) - shown as the banner on the page.
async function lastUndoableReset() {
  const { rows } = await pool.query(
    `SELECT id, created_at AS "at", created_by_name AS "byName", start_date::text AS "startDate"
       FROM vehicle_planning_reset_backup WHERE undone_at IS NULL AND created_at > NOW() - ($1 || ' days')::interval ORDER BY id DESC LIMIT 1`,
    [String(RESET_UNDO_DAYS)],
  );
  return rows[0] ?? null;
}

// POST /api/vehicle-planning/reset/undo - body { id } - admin. Puts back what the reset cleared WITHOUT overwriting anything done since: a trip is added back only when its
// order is not on that vehicle now, and a slip gets its vehicle and driver back only when it has none now.
router.post('/vehicle-planning/reset/undo', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    if (!isAdminUser(req)) return res.status(403).json({ message: 'Only an admin can undo a reset.' });
    const last = await lastUndoableReset();
    const id = Number(req.body?.id);
    if (!last || last.id !== id) return res.status(404).json({ message: 'That reset can no longer be undone.' });
    const { rows } = await client.query(`SELECT * FROM vehicle_planning_reset_backup WHERE id = $1`, [id]);
    const b = rows[0];
    let trips = 0;
    await client.query('BEGIN');
    for (const v of b.vehicles as Array<{ vehicleId: number; history: VehiclePlanningOrderEntry[] }>) {
      const cur = await client.query(`SELECT order_history AS "h" FROM vehicle_planning_state WHERE vehicle_id = $1 FOR UPDATE`, [v.vehicleId]);
      const have = new Set(((cur.rows[0]?.h ?? []) as VehiclePlanningOrderEntry[]).map((e) => e.orderNumber));
      const back = v.history.filter((e) => !have.has(e.orderNumber));
      trips += back.length;
      if (cur.rows[0]) await client.query(`UPDATE vehicle_planning_state SET order_history = $1 WHERE vehicle_id = $2`, [JSON.stringify([...(cur.rows[0].h ?? []), ...back]), v.vehicleId]);
      else await client.query(`INSERT INTO vehicle_planning_state (vehicle_id, order_history) VALUES ($1, $2)`, [v.vehicleId, JSON.stringify(v.history)]);
    }
    let slips = 0;
    for (const s of b.slips as Array<{ id: number; vehicleNumber: string | null; vehicleInfoId: number | null; vehicleAssignedByCode: string | null; driverName: string | null }>) {
      const r = await client.query(
        `UPDATE proforma_slips SET vehicle_number = $2, vehicle_info_id = $3, vehicle_assigned_by_code = $4, driver_name = $5 WHERE id = $1 AND vehicle_info_id IS NULL`,
        [s.id, s.vehicleNumber, s.vehicleInfoId, s.vehicleAssignedByCode, s.driverName],
      );
      slips += r.rowCount ?? 0;
    }
    const startUpdate = await client.query(`UPDATE vehicle_planning_settings SET planning_start_date = $1 WHERE id = (SELECT id FROM vehicle_planning_settings ORDER BY id LIMIT 1)`, [b.previous_start_date]);
    if (!startUpdate.rowCount && b.previous_start_date) await client.query(`INSERT INTO vehicle_planning_settings (planning_start_date) VALUES ($1)`, [b.previous_start_date]);
    await client.query(`UPDATE vehicle_planning_reset_backup SET undone_at = NOW() WHERE id = $1`, [id]);
    await client.query('COMMIT');
    const { userCode, userName } = who(req);
    if (userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'update', entityType: 'planning_reset', entityId: String(id), details: `Planning reset #${id} undone by ${userName ?? userCode}: ${trips} trip(s) and ${slips} slip(s) put back`, userCode, userName });
    res.json({ trips, slips });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error undoing the planning reset:', error);
    res.status(500).json({ message: 'Failed to undo the reset' });
  } finally {
    client.release();
  }
});

// POST /api/vehicle-planning/start-date - body { startDate: 'YYYY-MM-DD' | null } - admin: move (or remove) the day a Refresh from Notion starts from.
router.post('/vehicle-planning/start-date', requirePageWrite('vehicle-planning'), async (req: Request, res: Response) => {
  try {
    if (!isAdminUser(req)) return res.status(403).json({ message: 'Only an admin can change the start date.' });
    const raw = req.body?.startDate;
    const day = raw == null || raw === '' ? null : String(raw).slice(0, 10);
    if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ message: 'Pick a valid day.' });
    await setPlanningStartDate(day);
    const { userCode, userName } = who(req);
    if (userCode) await storage.logActivity({ pageName: 'Vehicle Planning', action: 'update', entityType: 'planning_start_date', entityId: 'start-date', details: `Vehicle Planning start date ${day ? `set to ${day}` : 'removed'} by ${userName ?? userCode}`, userCode, userName });
    res.json({ startDate: day });
  } catch (error) {
    console.error('Error saving the planning start date:', error);
    res.status(500).json({ message: 'Failed to save the start date' });
  }
});

export default router;
