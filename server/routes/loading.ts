import { Router, Request, Response, NextFunction } from 'express';
import { storage } from '../storage';
import { pool, db } from '../db';
import { products as productsTable } from '@shared/schema';
import { inArray } from 'drizzle-orm';
import { requirePageAccess, requirePageWrite, WRITE_ADMIN_ROLES } from '../lib/pageAccess';
import { getPlantStateCode, getPalletSize, resolvePalletSizeOrQty, getUserPlants } from './order-scan';
import { reconcileProductPlantStockBarcode } from '../lib/stockBarcodeReconcile';
import {
  getPooledStock, getStatePlantNames, debitStatePool, reverseStockPullsForEvent, recordStockPulls,
  type StockPullContribution,
} from '../lib/statePool';
import {
  pushStoreKeeperInfoToNotion, getFinnyStatusOptions, syncOrderToNotion, settleNotionSync, reconcileOrderWithNotion,
  watchStatusAfterVehicleChange,
  isLaterStageStatus, NOTION_LOADING_STATUS, NOTION_LOADING_COMPLETE_STATUS, type NotionSyncOutcome,
} from '../services/notionOrderStatusSync';
import { searchNotionVehicleByNumber } from '../services/notionVehicleSync';
import { computeLoadDateReport, computeLoadDateActivity } from '../lib/loadDateReport';

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

// Supervisor designation gets the same ownership-bypass as admin on Loading specifically (open/
// view/scan/pause any load, change its STV, reopen it after completion) — explicit request, so
// they're never blocked by "someone else owns this load". Deliberately does NOT touch
// requireLoadingVoidAccess (delete/reset a load, void or edit a scan event) — that stays gated
// on isAdmin or an explicit scan-history write grant, unrelated to designation, so Supervisor
// never gets delete power through this.
function isSupervisor(req: Request): boolean {
  const designation = ((req.user as any)?.designation ?? '').toString().toLowerCase().trim();
  return designation === 'supervisor';
}

// Drop-in replacement for requirePageWrite('loading') on every Loading write route below — the
// designation-based ownership bypass above (isSupervisor, used inside checkLoadOwnership etc.)
// never even runs for a Supervisor whose base role is "read" with no separately-granted Write
// Access to Loading, because requirePageWrite('loading') rejects the request before any route
// handler code executes. Most Supervisor-designated accounts in this database are exactly that
// (role "read", no loading write grant) — so this middleware lets a Supervisor through
// unconditionally here, same as WRITE_ADMIN_ROLES already does inside requirePageWrite itself,
// instead of also requiring a separate manual grant on top of the designation. Scoped to this
// file's own routes only — the shared requirePageWrite in lib/pageAccess.ts is untouched, so
// Supervisor gets no write bypass on any OTHER page through this.
function requireLoadingWrite(req: Request, res: Response, next: NextFunction) {
  if (isSupervisor(req)) return next();
  return requirePageWrite('loading')(req, res, next);
}

const normalize = (value?: string | number | null) => String(value ?? '').trim().toLowerCase();

// Mirrors unloading.ts's canAccessPlant exactly — admin/roles with no plant restriction
// (getUserPlants returns null) can access anything; everyone else is limited to their assigned
// plants, matched case/whitespace-insensitively against whatever casing the slip's plant uses.
function canAccessPlant(req: Request, plant: string | null | undefined): boolean {
  const userPlants = getUserPlants(req.user);
  if (userPlants === null) return true;
  return userPlants.includes(normalize(plant));
}

// Resolves who "owns" a load for both the view and scan gates below. Normally that's just the
// slip's own loadingOwnerCode/Name (set on Start, moved by Claim). But a load started BEFORE the
// shift-handoff feature existed has no loadingOwnerCode at all — falling back to "open to
// anyone" for those would mean the very users this feature is meant to restrict (someone who
// never touched the order) could still open/scan it, just because it happens to be old. So for
// that case only, fall back to whoever's loading_records row actually created this load (the
// same "Creator" the landing list already shows) — the earliest one, matching withRto's loadDate.
async function resolveLoadOwner(slip: any): Promise<{ code: string | null; name: string | null }> {
  if (slip.loadingOwnerCode) return { code: slip.loadingOwnerCode, name: slip.loadingOwnerName ?? null };
  const { rows } = await pool.query(
    `SELECT created_by_code AS "code", created_by_name AS "name" FROM loading_records
     WHERE order_number = $1 ORDER BY created_at ASC LIMIT 1`,
    [slip.orderNumber],
  );
  return { code: rows[0]?.code ?? null, name: rows[0]?.name ?? null };
}

// Reshapes loading_handoffs (a log of individual transfers) into the full ordered chain of
// EVERY user who's held this load, each with the time window they held it AND how much they
// personally loaded during that window (loadedQty) — "first creator, how much they used, then
// new owner, how much they used", the actual per-owner contribution breakdown, not just names.
// This is display/reporting only — the single "current owner" access control actually checks
// (resolveLoadOwner/checkLoadOwnership/checkLoadViewAccess) never reads this.
// `handoffRows` must be pre-sorted DESC by claimedAt (the shape the /handoffs endpoint already
// queries in) — reversed internally to walk the chain oldest-first.
async function buildOwnerTimeline(slip: any, handoffRowsDesc: any[]): Promise<Array<{ code: string | null; name: string | null; from: Date | null; to: Date | null; loadedQty: number }>> {
  const handoffs = [...handoffRowsDesc].reverse(); // oldest first

  const { rows: loadRecordRows } = await pool.query(
    `SELECT created_at FROM loading_records WHERE order_number = $1 ORDER BY created_at ASC LIMIT 1`,
    [slip.orderNumber],
  );
  const loadStart: Date | null = loadRecordRows[0]?.created_at ?? null;

  // Every scan's own timestamp + qty for this order, in one query — kept ungrouped (not summed
  // by scanned_by_code) because loadedQty has to be scoped to EACH ROW'S own time window, not to
  // the person. If the same person owns this load twice (paused, handed off, then handed back to
  // them later), they get two separate rows — one per stint — and each row must only count what
  // happened during THAT stint, not their lifetime total, or both rows would show an identical
  // (and misleadingly doubled-looking) grand total instead of what actually happened in each one.
  const { rows: eventRows } = await pool.query(
    `SELECT scanned_at AS "scannedAt", total_qty AS "totalQty"
     FROM loading_scan_events WHERE order_number = $1 AND voided IS NOT TRUE`,
    [slip.orderNumber],
  );
  const qtyBetween = (from: Date | null, to: Date | null) =>
    eventRows.reduce((sum: number, ev: any) => {
      const t = new Date(ev.scannedAt).getTime();
      if (from && t < new Date(from).getTime()) return sum;
      if (to && t >= new Date(to).getTime()) return sum;
      return sum + Number(ev.totalQty ?? 0);
    }, 0);

  // Nobody has ever handed this off — the whole timeline is just whoever currently/originally
  // owns it (resolveLoadOwner already covers "no explicit owner at all" via the creator fallback).
  if (handoffs.length === 0) {
    const owner = await resolveLoadOwner(slip);
    if (!owner.code) return [];
    const to = slip.loadingCompletedAt ?? null;
    return [{ code: owner.code, name: owner.name, from: loadStart, to, loadedQty: qtyBetween(loadStart, to) }];
  }

  const timeline: Array<{ code: string | null; name: string | null; from: Date | null; to: Date | null; loadedQty: number }> = [];
  // The very first owner, before any handoff — captured on the FIRST handoff row's "from"
  // (that's who held it right up until that handoff's claim).
  timeline.push({
    code: handoffs[0].fromUserCode, name: handoffs[0].fromUserName,
    from: loadStart, to: handoffs[0].claimedAt ?? null,
    loadedQty: qtyBetween(loadStart, handoffs[0].claimedAt ?? null),
  });
  for (let i = 0; i < handoffs.length; i++) {
    const next = handoffs[i + 1];
    const from = handoffs[i].claimedAt ?? null;
    const to = next ? (next.claimedAt ?? null) : (slip.loadingCompletedAt ?? null);
    timeline.push({
      code: handoffs[i].toUserCode, name: handoffs[i].toUserName,
      from, to, loadedQty: qtyBetween(from, to),
    });
  }
  return timeline;
}

// Shared by every action that actually touches a load (scan, adjust-load) — returns an error
// message if this request shouldn't be allowed to proceed, or null if it's fine. No owner/
// creator at all (a load created with no loading_records row either — vehicle never linked)
// stays open to anyone with write access.
function checkLoadOwnership(slip: any, req: Request, owner: { code: string | null; name: string | null }): string | null {
  if (slip.loadingPausedAt) {
    return 'This load is paused — claim it from the list before scanning.';
  }
  if (owner.code && owner.code !== actor(req).userCode && !isAdmin(req) && !isSupervisor(req)) {
    return `This load is currently owned by ${owner.name ?? owner.code} — ask them to pause it, or wait for a transfer.`;
  }
  return null;
}

// Gates OPENING a load into the scan view (not just scanning it) — stricter than
// checkLoadOwnership in one way (a load someone else owns can't even be opened, not just
// scanned) and looser in another (a PAUSED load can be opened by anyone, since that's exactly
// how someone else previews/claims it).
function checkLoadViewAccess(slip: any, req: Request, owner: { code: string | null; name: string | null }): string | null {
  if (!owner.code) return null;
  if (slip.loadingPausedAt) return null;
  if (owner.code === actor(req).userCode || isAdmin(req) || isSupervisor(req)) return null;
  // A pure read-only user (no Write Access grant to Loading at all) can't scan/act on this load
  // regardless of who owns it — there's nothing for the ownership rule to protect against for
  // them, so it never applies here; they can open and look at ANY slip. Write-capable users
  // still get the ownership block below, since for them it's warning against a real conflict
  // (thinking they can scan a load someone else is actively on).
  if (!hasWriteAccess(req.user as any, 'loading')) return null;
  return `This load is currently owned by ${owner.name ?? owner.code} — ask them to pause it before opening it.`;
}

// "Create Operation" already flips notionStatus to LOADING (see POST /start below) the first
// time it's run for an order — so notionStatus === LOADING already means "someone already
// started this load." Re-running Create Operation on the same order is refused using that same
// field, rather than a separate flag: it doubles as a live link back to Notion too, since a sync
// that changes "Finny Status :" away from LOADING on Notion's side automatically re-opens it here
// the next time this slip is read, with no extra plumbing needed.
function isAlreadyLoading(notionStatus?: string | null): boolean {
  return String(notionStatus ?? '').trim().toUpperCase() === NOTION_LOADING_STATUS;
}

// The STV picked on Create Operation must actually be one of that plant's configured STVs —
// checked server-side, not just constrained by the dialog's <Select>, since the code is written
// into an audit field (storeKeeperInfo) that Notion users read.
async function plantStvList(plant: string | null | undefined): Promise<string[]> {
  const name = String(plant ?? '').trim();
  if (!name) return [];
  const { rows } = await pool.query(
    `SELECT s.stv FROM plant_stvs s JOIN plants p ON p.id = s.plant_id WHERE LOWER(p.name) = LOWER($1)`,
    [name],
  );
  return rows.map((r: any) => String(r.stv));
}

// Whether this plant requires a Sort Slip to already exist before Create Operation is allowed —
// the Plant Management toggle (plants.require_sort_slip_first). Defaults to false (no such
// requirement) for a plant with no row at all, same fallback every other plant flag here uses.
async function plantRequiresSortSlipFirst(plant: string | null | undefined): Promise<boolean> {
  const name = String(plant ?? '').trim();
  if (!name) return false;
  const { rows } = await pool.query(
    `SELECT require_sort_slip_first FROM plants WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [name],
  );
  return !!rows[0]?.require_sort_slip_first;
}

// Any Sort Slip for this order counts — not necessarily a completed one (see sortSlips.status in
// shared/schema.ts). Create Operation only cares that sorting has been set up, not finished.
async function orderHasSortSlip(orderNumber: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM sort_slips WHERE order_number = $1 LIMIT 1`, [orderNumber]);
  return rows.length > 0;
}

// StoreKeeper Info = everyone who has held this load, in the order they took it, then every
// distinct platform/STV this load has ever recorded, exactly as configured for the plant:
// "YASH PATEL, PLT-05", after a handoff "YASH PATEL, RAHUL SHARMA, PLT-05", and after the load
// later moves to a second platform "YASH PATEL, RAHUL SHARMA, PLT-05, PLT-08" — same
// append-only, never-remove treatment names already got, extended to platforms on explicit
// request (previously a "correction" replaced the one-and-only STV outright, silently losing
// which platform it actually started on). Full name, upper-cased — was first-name-only (just the
// first word) until an explicit request to use the full name instead. It used to reduce the STV
// to a bare platform number ("YASH, pt: 5"), which hid which STV was picked and made "STV-01"
// read the same as "PLT-01".
const fullNameOf = (userName: string | null | undefined) =>
  String(userName ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

// Dedupes case/whitespace-insensitively, first appearance kept — someone who pauses and later
// claims the same load back is not listed twice, and re-recording a platform that's already
// there doesn't duplicate it either.
function dedupeKeepFirst(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((v) => v.trim().toUpperCase())
    .filter((v) => v && !seen.has(v) && seen.add(v));
}

function buildStoreKeeperInfo(names: string[], stvs: string[]): string {
  const uniqueNames = dedupeKeepFirst(names);
  const uniqueStvs = dedupeKeepFirst(stvs);
  return [...uniqueNames, ...uniqueStvs].join(', ');
}

// Splits what's already recorded back into names vs. platforms — a plain "last part = STV"
// split (the old single-platform assumption) can't work once there can be several trailing STV
// parts, so this instead checks each part against the plant's OWN configured STV list: anything
// that matches one (case/whitespace-insensitive) is a platform, everything else is a name. A
// value with no comma holds no names (just the very first STV, if even that's been recorded).
function storeKeeperNames(info: string | null | undefined, allowedStvs: string[]): string[] {
  const parts = String(info ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const stvSet = new Set(allowedStvs.map((s) => normalize(s)));
  return parts.filter((p) => !stvSet.has(normalize(p)));
}

function storeKeeperStvsSoFar(info: string | null | undefined, allowedStvs: string[]): string[] {
  const parts = String(info ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const stvSet = new Set(allowedStvs.map((s) => normalize(s)));
  return parts.filter((p) => stvSet.has(normalize(p)));
}

function formatStoreKeeperInfo(userName: string | null | undefined, stv: string): string {
  return buildStoreKeeperInfo([fullNameOf(userName)], [stv]);
}

// Who created this load's very first loading_records row — the same "Creator" the landing list
// already shows. Kept separate from resolveLoadOwner (which only falls back to this when no
// owner has been explicitly set) because Complete access below allows the creator ALWAYS, even
// once ownership has since moved on to someone else via a handoff.
async function resolveLoadCreatorCode(orderNumber: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT created_by_code AS "code" FROM loading_records WHERE order_number = $1 ORDER BY created_at ASC LIMIT 1`,
    [orderNumber],
  );
  return rows[0]?.code ?? null;
}

// Complete is restricted to whoever has a real stake in THIS load: its creator, its current
// owner, or admin/super-admin/Supervisor — never a blanket "anyone whose designation isn't
// Loader/Helper/Driver/Scanner" rule (that let any office-type user force-complete any load,
// not just one they actually started or are holding).
async function canCompleteLoad(req: Request, slip: any): Promise<boolean> {
  if (isAdmin(req) || isSupervisor(req)) return true;
  const userCode = actor(req).userCode;
  if (!userCode) return false;
  const owner = await resolveLoadOwner(slip);
  if (owner.code === userCode) return true;
  const creatorCode = await resolveLoadCreatorCode(slip.orderNumber);
  return creatorCode === userCode;
}

// Reopening (undoing Complete) is stricter than completing: an admin/super-admin, or the load's
// CURRENT owner (the person holding it when it finished). This middleware only checks the user is
// signed in — the owner half needs the slip, so the rule itself is applied inside the handler.
function requireReopenAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
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

// Load Master's write access: an admin, or anyone granted Write Access on the Load Master page itself.
// It lets them void a scan, remove a voided entry from the history and delete a load from the slip view
// there — the same actions requireLoadingVoidAccess guards, reached from the Load Master screen.
function requireLoadMasterWrite(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const user = req.user as any;
  if (isAdmin(req) || hasWriteAccess(user, 'loading-overview')) return next();
  return res.status(403).json({ message: 'Write access to Load Master is required' });
}

// The first entry on a load — any scan (gun, camera, manual, offline), Add Extra, or the + / − buttons — is
// what turns the slip's status to LOADING, in the app and in Notion. Create Operation no longer does. Cheap
// on every later entry: it only looks at the slip row the route already has, and does nothing when the
// slip is already Loading, completed, or past that stage (Dispatched, Delivered ...). Returns true when it
// changed the status, so the caller can show the new one straight away.
async function ensureLoadingOnEntry(slip: any, who: { userCode?: string; userName?: string }): Promise<boolean> {
  try {
    if (!slip || slip.loadingCompletedAt) return false;
    const current = String(slip.notionStatus ?? '').trim();
    if (isAlreadyLoading(current) || isLaterStageStatus(current)) return false;
    await storage.updateProformaSlip(slip.id, {
      notionStatus: NOTION_LOADING_STATUS,
      // Remembered so Delete load can put it back.
      statusBeforeLoading: slip.statusBeforeLoading || current,
    } as any);
    void syncOrderToNotion(slip.orderNumber, { status: NOTION_LOADING_STATUS }, who);
    try {
      await storage.logActivity({
        pageName: 'Loading', action: 'update', entityType: 'proforma_slip', entityId: slip.id,
        details: `First entry on order ${slip.orderNumber} — status changed from ${current || 'empty'} to LOADING`,
        userCode: who.userCode, userName: who.userName,
      });
    } catch { /* the status change matters more than its log line */ }
    return true;
  } catch (error) {
    console.error('[Loading] Could not set LOADING on the first entry:', error instanceof Error ? error.message : error);
    return false;
  }
}

// Attaches the linked vehicle's RTO number AND volume capacity to a slip response, resolved
// live — never stored on proforma_slips itself (see file header comment). proforma_slips.
// totalVolume is a SEPARATE number: the order's own required cargo volume, computed from
// Product Master's per-item volumeInCuFt at import/scan time (see server/services/
// proformaNotionSync.ts) — it is NOT the vehicle's capacity, and linking a vehicle no longer
// overwrites it with one (it used to; see the /link-vehicle comment below for why that changed).
// Resolved by the EXACT vehicle_info row (vehicleInfoId) when known — vehicleNumber alone is no
// longer unique in Vehicle Master (two Notion pages can share one), so a by-number lookup could
// return a different row than the one actually linked. Falls back to by-number-or-RTO for the
// rare slip with no vehicleInfoId at all (older data, or Notion's text genuinely matched nothing
// in Vehicle Master — see writeOrderToDb in proformaNotionSync.ts, which is what normally
// resolves vehicleInfoId at sync time now).
//
// Also attaches `suggestedVehicle` — the full Vehicle Master row, not just its RTO — whenever a
// vehicle resolves but nobody has confirmed it yet (vehicleAssignedByCode still null). The
// Loading page's confirm dialog uses this to pre-select the exact row directly, rather than
// re-deriving it from vehicleNumber text on the client (see LoadOperation.tsx's pre-fill effect).
async function withRto(slip: any) {
  // loadDate — when this order's load operation actually started (loading_records.created_at,
  // the same value the landing table's own "Load Date" column shows), separate from the slip's
  // own orderDate. Null until Create Operation has been run for this order at least once.
  // createdByCode/Name — who ran Create Operation for this order (the landing list's own
  // "Creator" column) — same row, so no extra query: the client needs this to know whether
  // Complete's creator-always-allowed rule (canCompleteLoad) applies to the signed-in user.
  const { rows: loadRecordRows } = await pool.query(
    `SELECT created_at, created_by_code AS "createdByCode", created_by_name AS "createdByName"
     FROM loading_records WHERE order_number = $1 ORDER BY created_at ASC LIMIT 1`,
    [slip.orderNumber],
  );
  const loadDate = loadRecordRows[0]?.created_at ?? null;
  const createdByCode = loadRecordRows[0]?.createdByCode ?? null;
  const createdByName = loadRecordRows[0]?.createdByName ?? null;

  if (!slip?.vehicleNumber) return { ...slip, rtoNumber: null, vehicleVolume: null, suggestedVehicle: null, loadDate, createdByCode, createdByName };
  const vehicle = slip.vehicleInfoId
    ? await storage.getVehicleInfo(slip.vehicleInfoId)
    : await storage.getVehicleInfoByVehicleNumberOrRto(slip.vehicleNumber);
  const suggestedVehicle = !slip.vehicleAssignedByCode && vehicle
    ? { id: vehicle.id, vehicleNumber: vehicle.vehicleNumber, rtoNumber: vehicle.rtoNumber, driver: vehicle.driver, company: vehicle.company, manufacturer: vehicle.manufacturer, volume: vehicle.volume }
    : null;
  return { ...slip, rtoNumber: vehicle?.rtoNumber ?? null, vehicleVolume: vehicle?.volume ?? null, suggestedVehicle, loadDate, createdByCode, createdByName };
}

// Attaches load progress to each proforma item (expected/loaded/remaining/itemsPerPallet,
// current stock at this plant) and reports whether the whole order is fully loaded — the same
// shape both the GET (page load) and POST /scan (after each scan) responses return, so the
// client always has one consistent source of truth for "what's left to load".
async function withProgress(slip: any, items: any[]) {
  const [state, { rows: loadedRows }] = await Promise.all([
    getPlantStateCode(pool, slip.plant ?? ''),
    pool.query(
      `SELECT barcode, COALESCE(SUM(total_qty), 0)::int AS "loadedQty"
       FROM loading_scan_events WHERE order_number = $1 AND voided IS NOT TRUE GROUP BY barcode`,
      [slip.orderNumber],
    ),
  ]);
  const loadedByBarcode = new Map<string, number>(loadedRows.map((r: any) => [normalize(r.barcode), r.loadedQty]));

  // Everything this response needs from Product Master and stock is read in TWO queries up front
  // (it used to be 1 product query + 3 stock queries PER ITEM — ~280 queries for a 70-item order on
  // every scan and every refetch, which queued behind the pool and made scans take seconds).
  const wantedBarcodes = Array.from(new Set([
    ...items.map((it) => String(it.barcode ?? '').trim()),
    ...loadedRows.map((r: any) => String(r.barcode ?? '').trim()),
  ].filter(Boolean)));
  const productsByBarcode = new Map<string, any[]>();
  const stockByBarcode = new Map<string, number>();
  if (wantedBarcodes.length > 0) {
    const [productRows, statePlants] = await Promise.all([
      db.select().from(productsTable).where(inArray(productsTable.barcode, wantedBarcodes)),
      getStatePlantNames(pool, slip.plant ?? ''),
    ]);
    for (const pr of productRows) {
      const key = String(pr.barcode ?? '').trim();
      if (!productsByBarcode.has(key)) productsByBarcode.set(key, []);
      productsByBarcode.get(key)!.push(pr);
    }
    const { rows: stockRows } = await pool.query(
      `SELECT barcode, COALESCE(SUM(in_stock), 0)::int AS total FROM product_plant_stock
       WHERE barcode = ANY($1::text[]) AND plant = ANY($2::text[]) GROUP BY barcode`,
      [wantedBarcodes, statePlants],
    );
    for (const r of stockRows as any[]) stockByBarcode.set(String(r.barcode), r.total);
  }
  // One row per barcode is the normal case; a barcode that sits on several product rows (one per
  // plant/state) still goes through the plant-aware lookup so the right row is picked.
  const productFor = async (barcode: string) => {
    const key = String(barcode ?? '').trim();
    const matches = productsByBarcode.get(key);
    if (!matches || matches.length === 0) return undefined;
    if (matches.length === 1) return matches[0];
    return storage.getProductByBarcode(key, slip.plant);
  };
  const stockFor = (barcode: string) => stockByBarcode.get(String(barcode ?? '').trim()) ?? 0;

  const progressItems = await Promise.all(items.map(async (item) => {
    const product = item.barcode ? await productFor(item.barcode) : undefined;
    const expected = item.quantity ?? 0;
    const loaded = loadedByBarcode.get(normalize(item.barcode)) ?? 0;
    const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, expected);
    let stockAvailable: number | null = null;
    if (item.barcode) {
      // Case/whitespace-insensitive plant match — proforma_slips.plant comes from whatever
      // casing the source (e.g. Notion's "Plant :"/"Stk Plant :") used ("VALSAD"), which won't
      // exact-match product_plant_stock's canonical casing ("Valsad") otherwise, causing a false
      // "no stock" even though Stock Overview (which already matches case-insensitively — see
      // server/routes/scan-sessions.ts) shows stock for the same plant. Pooled across every
      // plant in slip.plant's state (server/lib/statePool.ts) — matches what debitStatePool
      // will actually allow a scan to draw on, so this figure and a real scan never disagree.
      stockAvailable = stockFor(item.barcode);
    }
    return {
      ...item, expected, loaded, remaining: Math.max(0, expected - loaded),
      // Extra is simply what is loaded beyond what was expected — always agrees with Loaded and
      // Remaining. (It used to add up the rows flagged Extra, which went wrong after a "−" or a "+"
      // that crossed the expected quantity: the stale Extra rows were never taken back out.) Extra can
      // only be added once an item is complete now, so there is no "Extra inside the expected qty".
      extraQty: Math.max(0, loaded - expected),
      itemsPerPallet,
      // The pallet size actually configured in Product Master (0 when GJ/MP PLT is blank).
      // itemsPerPallet falls back to the line quantity so totals still count one pallet; this
      // field is the honest answer, so the page can refuse to auto-scan a size nobody set.
      realPackSize: getPalletSize(product ?? null, state),
      isComplete: expected > 0 && loaded >= expected, stockAvailable,
    };
  }));

  // Extra scanned for a product that isn't on this order AT ALL (Add Extra's "different item"
  // path, server/routes/loading.ts's own /scan handler) has no proforma_slip_items row to
  // attach its progress to — without this, the scan succeeds and debits stock (loading_scan_events
  // gets a real row) but the item never appears anywhere on the page, looking exactly like
  // "added but not added". Synthesized here as a zero-expected row built straight from Product
  // Master, same shape as a normal row, so the table and every total (including the "Extra"
  // tile's Math.max(0, loaded - expected) sum) treat it identically to a real line — expected 0
  // means its whole loaded qty already counts as extra under that same formula.
  const knownBarcodes = new Set(items.map((it) => normalize(it.barcode)));
  const offOrderBarcodes = Array.from(loadedByBarcode.keys()).filter((bc) => bc && !knownBarcodes.has(bc));
  // The keys above are lowercased for matching, but Product Master lookups are case-sensitive and
  // letter barcodes exist (e.g. "A01" advertisement stands) — look up by the barcode as scanned.
  const originalBarcode = new Map<string, string>(loadedRows.map((r: any) => [normalize(r.barcode), String(r.barcode).trim()]));
  const offOrderItems = (await Promise.all(offOrderBarcodes.map(async (bc) => {
    const product = await productFor(originalBarcode.get(bc) ?? bc);
    if (!product) return null; // shouldn't happen — /scan already requires Product Master to have it — but never render junk if it somehow does
    const loaded = loadedByBarcode.get(bc) ?? 0;
    const itemsPerPallet = resolvePalletSizeOrQty(product, state, 0);
    const stockAvailable = stockFor(product.barcode ?? bc);
    return {
      id: -product.id, // negative so it can never collide with a real proforma_slip_items.id
      barcode: product.barcode ?? bc, itemName: product.name ?? bc, sapCode: product.sapCode ?? null,
      srNo: product.newSr ?? null, volumeInCuFt: product.volumeInCuFt ?? null,
      quantity: null,
      expected: 0, loaded, remaining: 0, extraQty: loaded, itemsPerPallet,
      realPackSize: getPalletSize(product, state),
      isComplete: true, stockAvailable,
    };
  }))).filter((it): it is NonNullable<typeof it> => it !== null);

  const allItems = [...progressItems, ...offOrderItems];
  const allComplete = allItems.length > 0 && allItems.every((i) => i.isComplete);

  // Volume actually scanned onto the vehicle so far — each item's own snapshotted
  // volumeInCuFt (Product Master at import time, immutable per file header) times how much of
  // it has actually been loaded, summed. Distinct from slip.totalVolume (the order's full planned
  // volume) and vehicleVolume (the vehicle's capacity) — this is "how much is on the truck right now".
  const loadedVolume = allItems.reduce((sum, item) => {
    const perUnit = parseFloat(item.volumeInCuFt ?? '');
    return sum + (Number.isFinite(perUnit) ? perUnit * item.loaded : 0);
  }, 0);

  return { items: allItems, allComplete, loadedVolume: Number(loadedVolume.toFixed(2)) };
}

// GET /api/loading/proforma/search?q=  — suggestions dropdown while typing/scanning.
// Matches partial order number OR party name, newest first, capped small (a dropdown, not a
// report). Raw SQL here (not storage.listProformaSlips, which has no search) — a small,
// self-contained query rather than a new IStorage method for a single lookup.
router.get('/loading/proforma/search', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const userPlants = getUserPlants(req.user);
    const params: any[] = [`%${q}%`];
    let plantCondition = '';
    if (userPlants !== null) {
      params.push(userPlants);
      plantCondition = `AND LOWER(plant) = ANY($${params.length})`;
    }
    const { rows } = await pool.query(
      // order_date::text — this is a raw pool.query (not Drizzle), so node-postgres's default
      // DATE type parser would otherwise hand back a JS Date object built at LOCAL midnight,
      // which res.json() then serializes as a UTC timestamp with the date shifted by the
      // server's own UTC offset (e.g. "2026-08-26" becomes "2026-08-25T18:30:00.000Z" on an
      // IST server) — exactly the kind of value the client's date-only rendering logic isn't
      // expecting, and slicing just the date portion of THAT then picks the wrong day. Casting
      // to text in SQL returns the plain "YYYY-MM-DD" Postgres already has, matching what
      // Drizzle's own (string-mode) date columns return elsewhere in this app.
      `SELECT id, order_number AS "orderNumber", party_name AS "partyName", plant, order_date::text AS "orderDate",
              vehicle_number AS "vehicleNumber"
       FROM proforma_slips
       WHERE (order_number ILIKE $1 OR party_name ILIKE $1) ${plantCondition}
       ORDER BY created_at DESC
       LIMIT 8`,
      params,
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
    // Read-only: looking a slip up (or previewing it in the Create-Operation dialog) never
    // changes its status. Starting the load is an explicit action — see POST /start below.
    const slip: any = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    // Everything the reply needs that does not depend on anything else is fetched at the same time
    // (it used to be one query after another, which is most of the wait when opening a slip).
    const [owner, rawItems, sortCheck, slipWithRto] = await Promise.all([
      resolveLoadOwner(slip),
      storage.getProformaSlipItems(slip.id),
      // Told to the Create Operation dialog up front, so it can warn and disable its button before
      // the operator even tries — POST /start below is the real enforcement either way.
      plantRequiresSortSlipFirst(slip.plant).then(async (required) => ({
        required, exists: required ? await orderHasSortSlip(slip.orderNumber) : true,
      })),
      withRto(slip),
    ]);
    const viewError = checkLoadViewAccess(slip, req, owner);
    if (viewError) return res.status(403).json({ message: viewError });
    const { items, allComplete, loadedVolume } = await withProgress(slip, rawItems);
    res.json({ slip: slipWithRto, items, allComplete, loadedVolume, sortSlipRequired: sortCheck.required, sortSlipExists: sortCheck.exists });

    // Opening a load quietly re-checks its vehicle and status in Notion (this app's values win for
    // Loading / Ready for Dispatch) — catches an earlier update that never got through. Runs after
    // the reply, only for loads started here, and at most once every 10 minutes per order since
    // the open page re-fetches this every few seconds. This only ever writes to Notion, never here.
    void reconcileOrderWithNotion(slip.orderNumber, actor(req), { throttleMs: 10 * 60 * 1000 });
  } catch (error) {
    console.error('Error fetching proforma slip for loading:', error);
    res.status(500).json({ message: 'Failed to fetch proforma slip' });
  }
});

// POST /api/loading/proforma/:orderNumber/sync-notion — the "Sync to Notion" button: re-check this
// one load's vehicle and status in Notion right now and fix whatever differs.
router.post('/loading/proforma/:orderNumber/sync-notion', requireLoadingWrite, async (req: Request, res: Response) => {
  try {
    const slip: any = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    const outcome = await reconcileOrderWithNotion(slip.orderNumber, actor(req));
    res.json({
      notion: outcome ?? { state: 'skipped', message: 'Nothing to sync yet — the load has to be started here first.' },
    });
  } catch (error) {
    console.error('Error syncing load to Notion:', error);
    res.status(500).json({ message: 'Failed to sync to Notion' });
  }
});

// POST /api/loading/proforma/:orderNumber/start — "Create Operation" on the Create Load Operation
// from Proforma dialog. This is what actually starts the load: it flips the slip to LOADING both
// locally and in Notion. Deliberately NOT done on lookup, so previewing a slip (or cancelling out
// of that dialog) leaves its status alone. No-op on a load that's already complete — reopening is
// its own explicit, admin-only action.
router.post('/loading/proforma/:orderNumber/start', requireLoadingWrite, async (req: Request, res: Response) => {
  try {
    let slip: any = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    // Already started — refuse a second Create Operation rather than silently reopening it.
    // Resuming an in-progress load still works fine from the landing list (a plain GET, doesn't
    // go through this endpoint at all) — this only guards the "start a new one" entry point.
    if (isAlreadyLoading(slip.notionStatus)) {
      // Notion already says LOADING. Only an admin / super-admin may still start it here — and only when
      // no load for this order exists in this app yet (a second one would just duplicate the first).
      const { rows: existingLoad } = await pool.query(`SELECT 1 FROM loading_records WHERE order_number = $1 LIMIT 1`, [slip.orderNumber]);
      if (existingLoad.length > 0) {
        return res.status(409).json({ message: 'A load for this order already exists — open it from the list instead of creating it again.' });
      }
      if (!isAdmin(req)) {
        return res.status(409).json({ message: 'Status is already Loading — not able to load.' });
      }
    }

    // Plant Management can require a Sort Slip to exist for this order before loading is allowed
    // to start at all — any Sort Slip, not necessarily a completed one. Checked here (not just
    // in the GET lookup that feeds the dialog) so this holds even for a direct API call.
    if (await plantRequiresSortSlipFirst(slip.plant)) {
      if (!(await orderHasSortSlip(slip.orderNumber))) {
        return res.status(400).json({ message: `Create a Sort Slip for order ${slip.orderNumber} before starting this load operation.` });
      }
    }

    // STV is mandatory here and ONLY here: this is the one moment it can be set, and every other
    // endpoint treats it as frozen afterwards. Refusing the start outright (rather than
    // defaulting to the plant's first STV) is deliberate — a wrong platform silently recorded in
    // storeKeeperInfo is worse than a blocked Create Operation.
    const requestedStv = String(req.body?.stv ?? '').trim();
    if (!requestedStv) {
      return res.status(400).json({ message: 'Select a Dispatch Directory before creating this load operation.' });
    }
    const allowedStvs = await plantStvList(slip.plant);
    if (allowedStvs.length === 0) {
      return res.status(400).json({ message: `No Dispatch Directory is configured for plant ${slip.plant ?? '—'} — add one in Plant Settings first.` });
    }
    const matchedStv = allowedStvs.find((s) => normalize(s) === normalize(requestedStv));
    if (!matchedStv) {
      return res.status(400).json({ message: `"${requestedStv}" is not a Dispatch Directory configured for plant ${slip.plant ?? '—'}.` });
    }

    // The status is NOT changed here any more: it becomes LOADING on the load's first entry (see
    // ensureLoadingOnEntry), so a created-but-unscanned load keeps the status the slip had.
    const notionOutcome: NotionSyncOutcome | undefined = undefined;

    // First-time owner assignment — whoever runs Create Operation becomes the one allowed to
    // scan it, same as the old implicit "creator" idea, just tracked explicitly now so it can be
    // paused/handed off. Never overwrites an existing owner (this endpoint is only reachable
    // before loading starts anyway, per the isAlreadyLoading guard above).
    // First-time owner + STV assignment. storeKeeperInfo is stamped from the pair here and only
    // here: it names the person who STARTED the load, so a later pause/handoff (which moves
    // loadingOwnerCode) deliberately leaves it alone — the owner timeline already records who
    // took over. Guarded on loadingStv so re-entry can never restamp it either.
    if (!slip.loadingOwnerCode || !slip.loadingStv) {
      const { userCode, userName } = actor(req);
      const patch: Record<string, unknown> = {};
      if (!slip.loadingOwnerCode) {
        patch.loadingOwnerCode = userCode ?? null;
        patch.loadingOwnerName = userName ?? null;
      }
      if (!slip.loadingStv) {
        patch.loadingStv = matchedStv;
        patch.storeKeeperInfo = formatStoreKeeperInfo(userName, matchedStv);
        // From here on this load's StoreKeeper Info is mirrored to Notion — only loads created
        // from now, never ones started before this existed.
        patch.notionStoreKeeperPush = true;
      }
      const updated = await storage.updateProformaSlip(slip.id, patch as any);
      if (updated) {
        slip = updated;
        if (patch.storeKeeperInfo) void pushStoreKeeperInfoToNotion(slip.orderNumber, (slip as any).storeKeeperInfo);
      }
    }

    // The landing-list row is created here, at Create Operation, and nowhere else — linking a
    // vehicle alone never lists the slip. Per-order advisory lock so a double click or retry can't
    // insert it twice.
    {
      const { userCode, userName } = actor(req);
      const vehicleForRow: any = await withRto(slip);
      const recClient = await pool.connect();
      try {
        await recClient.query('BEGIN');
        await recClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`loading_record:${slip.orderNumber}`]);
        const { rows: existingRows } = await recClient.query(
          `SELECT id FROM loading_records WHERE order_number = $1 LIMIT 1`, [slip.orderNumber],
        );
        if (!existingRows[0]) {
          await recClient.query(
            `INSERT INTO loading_records (order_number, proforma_slip_id, party_name, plant, vehicle_number, rto_number, volume, created_by_code, created_by_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [slip.orderNumber, slip.id, slip.partyName, slip.plant, slip.vehicleNumber ?? null, vehicleForRow?.rtoNumber ?? null,
             vehicleForRow?.vehicleVolume != null ? String(vehicleForRow.vehicleVolume) : null, userCode ?? null, userName ?? null],
          );
        }
        await recClient.query('COMMIT');
      } catch (e) {
        await recClient.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        recClient.release();
      }
    }

    const rawItems = await storage.getProformaSlipItems(slip.id);
    const { items, allComplete, loadedVolume } = await withProgress(slip, rawItems);
    const withVehicle: any = await withRto(slip);
    // Does the order fit on the vehicle it is going out on? The dialog checks the same pair and
    // makes the operator tick it before creating, but the answer is computed here too so a load
    // started any other way still says so, and so the fact is recorded against the order rather
    // than living only on one screen. Informational — it never refuses the start.
    const orderVolume = parseFloat(slip.totalVolume ?? '');
    const vehicleCapacity = withVehicle?.vehicleVolume != null ? Number(withVehicle.vehicleVolume) : null;
    const capacityWarning =
      Number.isFinite(orderVolume) && vehicleCapacity != null && orderVolume > vehicleCapacity
        ? `This order needs ${orderVolume} cu ft but ${withVehicle.vehicleNumber ?? 'this vehicle'} holds only ${vehicleCapacity} cu ft.`
        : null;
    if (capacityWarning) {
      const { userCode, userName } = actor(req);
      await storage.logActivity({
        pageName: 'Loading', action: 'update', entityType: 'proforma_slip', entityId: slip.id,
        details: `Load started over vehicle capacity for order ${slip.orderNumber} by ${userName ?? userCode} — ${capacityWarning}`,
        userCode, userName,
      });
    }
    res.json({ slip: withVehicle, items, allComplete, loadedVolume, capacityWarning, notion: notionOutcome });
  } catch (error) {
    console.error('Error starting load:', error);
    res.status(500).json({ message: 'Failed to start load' });
  }
});

// PATCH /api/loading/proforma/:orderNumber/stv — admin, super-admin, Supervisor, or the load's
// CURRENT owner. loadingStv (the single "current" platform column, used everywhere else the app
// needs just one) is still replaced outright — but storeKeeperInfo now ADDS the new platform to
// whatever's already recorded there instead of losing the earlier one: a load that genuinely
// moved from PLT-05 to PLT-08 keeps both in its history ("YASH PATEL, PLT-05, PLT-08"), the same
// append-only treatment names get, rather than the correction silently erasing which platform it
// actually started on.
router.patch('/loading/proforma/:orderNumber/stv', requireLoadingWrite, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ message: 'Only an admin can change a load\'s Dispatch Directory.' });
    }
    const slip: any = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    // Was missing here even before today's Supervisor/current-owner extension — harmless while
    // this was admin-only (admin is typically plant-unrestricted anyway), but a real gap now
    // that a plant-restricted Supervisor or owner can reach this route too.
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const isCurrentOwner = !!slip.loadingOwnerCode && slip.loadingOwnerCode === actor(req).userCode;
    if (!isAdmin(req) && !isSupervisor(req) && !isCurrentOwner) {
      return res.status(403).json({ message: 'Only an admin, supervisor, or this load\'s current owner can change its STV.' });
    }

    const requestedStv = String(req.body?.stv ?? '').trim();
    if (!requestedStv) return res.status(400).json({ message: 'stv is required' });
    const allowedStvs = await plantStvList(slip.plant);
    const matchedStv = allowedStvs.find((s) => normalize(s) === normalize(requestedStv));
    if (!matchedStv) {
      return res.status(400).json({ message: `"${requestedStv}" is not a Dispatch Directory configured for plant ${slip.plant ?? '—'}.` });
    }

    // Keep every name already recorded (all owners so far, in order) so a correction only adds
    // the STV. Falls back to the current owner for a slip whose storeKeeperInfo holds no names.
    const existingNames = storeKeeperNames(slip.storeKeeperInfo, allowedStvs);
    const existingStvs = storeKeeperStvsSoFar(slip.storeKeeperInfo, allowedStvs);
    const updated = await storage.updateProformaSlip(slip.id, {
      loadingStv: matchedStv,
      storeKeeperInfo: buildStoreKeeperInfo(
        existingNames.length ? existingNames : [fullNameOf(slip.loadingOwnerName)],
        [...existingStvs, matchedStv],
      ),
    } as any);
    if (!updated) return res.status(500).json({ message: 'Failed to update Dispatch Directory' });
    res.json({ slip: updated });
    if ((slip as any).notionStoreKeeperPush) void pushStoreKeeperInfoToNotion(updated.orderNumber, (updated as any).storeKeeperInfo);
  } catch (error) {
    console.error('Error updating load STV:', error);
    res.status(500).json({ message: 'Failed to update Dispatch Directory' });
  }
});

// POST /api/loading/proforma/:orderNumber/pause — the current owner (or admin) steps away from
// this load. While paused, scanning/adjusting is blocked for EVERYONE — including the owner —
// until someone runs Claim below. This is the "current slip pause" half of the handoff: pausing
// alone never changes who owns it or writes a handoff row; that only happens on an actual Claim.
router.post('/loading/proforma/:orderNumber/pause', requireLoadingWrite, async (req: Request, res: Response) => {
  try {
    const slip: any = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    if (slip.loadingCompletedAt) {
      return res.status(409).json({ message: 'This load is already marked complete.' });
    }
    if (slip.loadingPausedAt) {
      return res.status(409).json({ message: 'Already paused.' });
    }
    const { userCode } = actor(req);
    const owner = await resolveLoadOwner(slip);
    if (owner.code && owner.code !== userCode && !isAdmin(req) && !isSupervisor(req)) {
      return res.status(403).json({ message: `This load is currently owned by ${owner.name ?? owner.code} — only they (or an admin) can pause it.` });
    }
    const updated = await storage.updateProformaSlip(slip.id, { loadingPausedAt: new Date() } as any);
    if (!updated) return res.status(500).json({ message: 'Failed to pause load' });
    res.json({ slip: await withRto(updated) });
  } catch (error) {
    console.error('Error pausing load:', error);
    res.status(500).json({ message: 'Failed to pause load' });
  }
});

// POST /api/loading/proforma/:orderNumber/claim — anyone with write access to Loading may claim
// a PAUSED load (that's the "anybody can activate" half) — this is the ONE action that actually
// moves ownership and, only when the claimer is a genuinely different person than whoever paused
// it, writes the handoff record ("who load and what time it['s] given to other").
router.post('/loading/proforma/:orderNumber/claim', requireLoadingWrite, async (req: Request, res: Response) => {
  try {
    const slip: any = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    if (!slip.loadingPausedAt) {
      return res.status(409).json({ message: 'This load is not paused — nothing to claim.' });
    }
    const { userCode, userName } = actor(req);
    const owner = await resolveLoadOwner(slip);
    const isHandoff = !!owner.code && owner.code !== userCode;
    if (isHandoff) {
      await pool.query(
        `INSERT INTO loading_handoffs (order_number, from_user_code, from_user_name, to_user_code, to_user_name, paused_at, claimed_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [slip.orderNumber, owner.code, owner.name, userCode ?? null, userName ?? null, slip.loadingPausedAt],
      );
    }
    // The person claiming is added to StoreKeeper Info after the earlier owners ("YASH, PLT-05" →
    // "YASH, RAHUL, PLT-05"). Only for a load started here with a recorded STV — a slip whose
    // StoreKeeper Info was typed in Notion isn't rewritten. Re-derives the full platform history
    // from what's already recorded (not just the current loadingStv) so an earlier STV correction
    // that added a second platform isn't lost on a later handoff.
    const slipStv = (slip as any).loadingStv as string | null | undefined;
    const storeKeeperPatch = slipStv
      ? await (async () => {
          const allowedStvs = await plantStvList(slip.plant);
          return {
            storeKeeperInfo: buildStoreKeeperInfo(
              [...storeKeeperNames(slip.storeKeeperInfo, allowedStvs), fullNameOf(userName)],
              [...storeKeeperStvsSoFar(slip.storeKeeperInfo, allowedStvs), slipStv],
            ),
          };
        })()
      : {};
    const updated = await storage.updateProformaSlip(slip.id, {
      loadingOwnerCode: userCode ?? null, loadingOwnerName: userName ?? null, loadingPausedAt: null,
      ...storeKeeperPatch,
    } as any);
    if (!updated) return res.status(500).json({ message: 'Failed to claim load' });
    res.json({ slip: await withRto(updated) });
    // Only when the claim actually changed StoreKeeper Info (a new name joined), and only for a
    // load created after the Notion push began.
    if (
      (slip as any).notionStoreKeeperPush
      && (updated as any).storeKeeperInfo !== slip.storeKeeperInfo
    ) {
      void pushStoreKeeperInfoToNotion(updated.orderNumber, (updated as any).storeKeeperInfo);
    }
  } catch (error) {
    console.error('Error claiming load:', error);
    res.status(500).json({ message: 'Failed to claim load' });
  }
});

// GET /api/notion-status-options — the Finny Status options with Notion's own colour for each, so
// the Loading and Proforma Slips pages can show a status in the colour Notion shows it in. Any
// signed-in user (both pages need it); it exposes no order data.
router.get('/notion-status-options', async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  res.json({ options: await getFinnyStatusOptions() });
});

// GET /api/loading/proforma/:orderNumber/stock?barcode= — stock a scan of this barcode could draw
// on for this order's plant (pooled across the plant's state, same figure /scan checks). Used by
// Add Extra, whose picked product may not be on the slip and so has no stockAvailable row.
router.get('/loading/proforma/:orderNumber/stock', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const barcode = String(req.query.barcode ?? '').trim();
    if (!barcode) return res.status(400).json({ message: 'barcode is required' });
    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    const { total } = await getPooledStock(pool, barcode, slip.plant ?? '');
    res.json({ stock: total });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to fetch stock' });
  }
});

// GET /api/loading/proforma/:orderNumber/handoffs — the shift-handoff history for this order,
// newest first. Empty for a load that's never actually changed hands.
router.get('/loading/proforma/:orderNumber/handoffs', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, order_number AS "orderNumber", from_user_code AS "fromUserCode", from_user_name AS "fromUserName",
              to_user_code AS "toUserCode", to_user_name AS "toUserName", paused_at AS "pausedAt", claimed_at AS "claimedAt"
       FROM loading_handoffs WHERE order_number = $1 ORDER BY claimed_at DESC`,
      [req.params.orderNumber],
    );

    // `items` above is the raw log, newest first (unchanged — existing callers rely on that
    // order for "latest handoff" display). `timeline` is the same data reshaped into the full
    // ordered chain of who owned this load and for how long — every user who's ever touched it,
    // not just the current one. Never used for access control (see checkLoadOwnership/
    // checkLoadViewAccess, which only ever look at the CURRENT owner) — this is display/reporting
    // only.
    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    const timeline = slip ? await buildOwnerTimeline(slip, rows) : [];

    res.json({ items: rows, timeline });
  } catch (error) {
    console.error('Error fetching load handoffs:', error);
    res.status(500).json({ message: 'Failed to fetch handoff history' });
  }
});

// Loading suggests Krupa's own fleet, hired TRANSPORT vehicles, and the "DUMMY" test vehicle —
// Vehicle Master also carries other companies' vehicles (SCRAP, ...) that are real data
// but never relevant to assign onto a Krupa load. Applied to BOTH the local search and the
// Notion fallback below, so neither path can surface one.
export function qualifiesForLoadingVehiclePicker(company: string | null | undefined): boolean {
  const c = (company ?? '').toLowerCase();
  return c.includes('krupa') || c.includes('transport') || c.includes('dummy');
}

// GET /api/loading/vehicles/search?q=  — suggestions dropdown for the vehicle picker. Matches
// against vehicle number, driver, company, or manufacturer — "anything user can enter", per
// spec. Vehicle Master is small enough (tens–low hundreds of rows) that filtering the already-
// fetched list in memory is simpler and fast enough than building a dedicated SQL search.
//
// Local-only misses a vehicle that was just added in Notion but hasn't synced down yet — at
// Create Operation that meant it simply couldn't be assigned. Falls back to a live Notion
// lookup ONLY when the local search comes up empty (not merged in every time — this keeps the
// common case, an already-synced vehicle, exactly as fast/cheap as before, and only pays for a
// Notion round-trip when there's actually nothing local to show). Any Notion match found this
// way is upserted into vehicle_info on the spot (searchNotionVehicleByNumber does this) so it
// comes back through the exact same {id, vehicleNumber, ...} shape and can be linked immediately
// with no special-casing on the frontend — fromNotion just flags it as freshly pulled in.
router.get('/loading/vehicles/search', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (q.length < 1) return res.json({ results: [] });
    const all = await storage.getAllVehicleInfo();
    const localMatches = all.filter((v) =>
      qualifiesForLoadingVehiclePicker(v.company)
      && [v.vehicleNumber, v.driver, v.company, v.manufacturer, v.series, v.rtoNumber]
        .some((f) => (f ?? '').toLowerCase().includes(q)));

    if (localMatches.length > 0) {
      const results = localMatches.slice(0, 8).map((v) => ({
        id: v.id, vehicleNumber: v.vehicleNumber, rtoNumber: v.rtoNumber, driver: v.driver,
        company: v.company, manufacturer: v.manufacturer, volume: v.volume,
      }));
      return res.json({ results });
    }

    try {
      const fromNotion = (await searchNotionVehicleByNumber(q)).filter((v) => qualifiesForLoadingVehiclePicker(v.company));
      const results = fromNotion.map((v) => ({
        id: v.id, vehicleNumber: v.vehicleNumber, rtoNumber: v.rtoNumber, driver: v.driver,
        company: v.company, manufacturer: v.manufacturer, volume: v.volume, fromNotion: true,
      }));
      return res.json({ results });
    } catch (notionError) {
      // A Notion hiccup here shouldn't take down the whole picker — just fall through to "no
      // matches" the way an unsynced vehicle already did before this fallback existed.
      console.error('Notion vehicle fallback search failed:', notionError);
      return res.json({ results: [] });
    }
  } catch (error) {
    console.error('Error searching vehicles for loading:', error);
    res.status(500).json({ message: 'Failed to search vehicles' });
  }
});

// GET /api/loading/records — the page's landing table. Visible to EVERY user with page access,
// not just admins/the creator — knowing what loads exist (and who currently owns each one) is
// what lets someone spot a paused load and claim it. Write access to any one load is still
// controlled separately, by checkLoadOwnership on the actual scan/adjust/pause actions, not by
// hiding rows here. Server-paginated (20/page, matching Scan History) and enriched with the
// slip's live completion/ownership status so the client can show Reopen/Claim only where they
// apply, without a second round trip per row.
// GET /api/loading/date-report — Total Summary across EVERY proforma slip loaded against this
// plant+order date. Loading has no vehicle/FIFO grouping (each slip is its own independent
// order), so this is a straight roll-up by plant+orderDate — mirrors Unloading's
// GET /api/unloading/date-report (see computeLoadDateReport's comment in loadDateReport.ts).
router.get('/loading/date-report', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const plant = String(req.query.plant ?? '').trim();
    const orderDate = String(req.query.orderDate ?? '').trim();
    if (!plant || !orderDate) return res.status(400).json({ message: 'plant and orderDate are required' });
    if (!canAccessPlant(req, plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const report = await computeLoadDateReport(plant, orderDate);
    if (!report) return res.status(404).json({ message: 'No proforma slips found for this plant and order date' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to build date report' });
  }
});

// GET /api/loading/date-report/scan-activity — same plant+order-date scope, raw scan events per slip.
router.get('/loading/date-report/scan-activity', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const plant = String(req.query.plant ?? '').trim();
    const orderDate = String(req.query.orderDate ?? '').trim();
    if (!plant || !orderDate) return res.status(400).json({ message: 'plant and orderDate are required' });
    if (!canAccessPlant(req, plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const activity = await computeLoadDateActivity(plant, orderDate);
    if (!activity) return res.status(404).json({ message: 'No proforma slips found for this plant and order date' });
    res.json(activity);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to build date activity' });
  }
});

// GET /api/loading/date-items?plant=&date= — Overall Scan Ops' "Loading" view: every product used
// by the Notion orders (proforma slips) of one plant + order date, rolled up to one row per
// product, with each party's share underneath. Read-only, guarded by the scan-viewer page (not
// Loading) since that is the page that shows it. Built on computeLoadDateReport, so the numbers
// match the Loading page's own date report; orders not loaded yet are included (loaded 0).
router.get('/loading/date-items', requirePageAccess(['loading-overview', 'scan-viewer']), async (req: Request, res: Response) => {
  try {
    let plant = String(req.query.plant ?? '').trim();
    let date = String(req.query.date ?? '').trim();
    const orderParam = String(req.query.order ?? '').trim();
    const PLANT_RESTRICTED = 'You can not access this plant — your account is restricted to the plant(s) assigned to you.';
    // One order asked for by number: its own plant and date decide what is read, and the plant
    // restriction is checked against THAT plant, so an order of another plant is refused.
    if (orderParam) {
      const { rows: found } = await pool.query(
        `SELECT plant, to_char(order_date, 'YYYY-MM-DD') AS d FROM proforma_slips WHERE order_number = $1 ORDER BY id LIMIT 1`, [orderParam],
      );
      if (found.length === 0) return res.json({ plant: '', date: '', orders: 0, parties: 0, items: [] });
      plant = String(found[0].plant ?? '');
      date = String(found[0].d ?? '');
      if (!plant || !canAccessPlant(req, plant)) return res.status(403).json({ message: `You can not open order #${orderParam} — it belongs to plant ${plant || 'unknown'}, which your account is restricted from (plant restriction).` });
    }
    if (!plant || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'plant and date (YYYY-MM-DD) are required' });
    const allPlants = plant === '__all__';
    if (!allPlants && !canAccessPlant(req, plant)) return res.status(403).json({ message: PLANT_RESTRICTED });

    // proforma_slips.plant keeps whatever casing the source used ("VALSAD"), the picker sends the
    // plant's configured name ("Valsad") — resolve the stored spelling(s) case-insensitively.
    // "__all__" = every plant this user may see (all of them for an unrestricted user).
    const userPlants = getUserPlants(req.user);
    const { rows: plantRows } = allPlants
      ? await pool.query(
          `SELECT DISTINCT plant FROM proforma_slips WHERE order_date = $1::date AND plant IS NOT NULL
             ${userPlants !== null ? 'AND LOWER(plant) = ANY($2)' : ''}`,
          userPlants !== null ? [date, userPlants] : [date],
        )
      : await pool.query(
          `SELECT DISTINCT plant FROM proforma_slips WHERE LOWER(plant) = LOWER($1) AND order_date = $2::date`,
          [plant, date],
        );
    const slips: any[] = [];
    for (const p of plantRows as any[]) {
      const report = await computeLoadDateReport(p.plant, date);
      if (report) slips.push(...report.slips.filter((s) => !orderParam || s.orderNumber === orderParam).map((s) => ({ ...s, plant: p.plant as string })));
    }

    const barcodes = Array.from(new Set(slips.flatMap((s) => s.items.map((i: any) => i.barcode))));
    const nameByBarcode = new Map<string, string>();
    const srByBarcode = new Map<string, string>();
    if (barcodes.length > 0) {
      const { rows: productRows } = await pool.query(
        `SELECT barcode, name, new_sr FROM products WHERE barcode = ANY($1::text[])`, [barcodes],
      );
      for (const r of productRows as any[]) {
        if (r.name && !nameByBarcode.has(r.barcode)) nameByBarcode.set(r.barcode, r.name);
        // A barcode can sit on more than one product row (one per plant) — take the first Sr No set.
        if (r.new_sr && !srByBarcode.has(r.barcode)) srByBarcode.set(r.barcode, String(r.new_sr));
      }
    }

    type PartyRow = { partyName: string; orderNumber: string; plant: string; vehicleNumber: string | null; expected: number; loaded: number; extra: number; remaining: number };
    type ItemAgg = { barcode: string; srNo: string | null; itemName: string; itemsPerPallet: number; expected: number; loaded: number; extra: number; remaining: number; parties: PartyRow[] };
    const byBarcode = new Map<string, ItemAgg>();
    for (const slip of slips) {
      for (const it of slip.items) {
        const loaded = it.receivedQty + it.extraQty;
        const row: ItemAgg = byBarcode.get(it.barcode) ?? {
          barcode: it.barcode, srNo: srByBarcode.get(it.barcode) ?? null, itemName: nameByBarcode.get(it.barcode) ?? it.itemName, itemsPerPallet: it.itemsPerPallet,
          expected: 0, loaded: 0, extra: 0, remaining: 0, parties: [],
        };
        const remaining = Math.max(0, it.expectedQty - loaded);
        row.expected += it.expectedQty;
        row.loaded += loaded;
        row.extra += it.extraQty;
        row.remaining += remaining;
        row.parties.push({
          partyName: slip.partyName, orderNumber: slip.orderNumber, plant: slip.plant, vehicleNumber: slip.vehicleNumber,
          expected: it.expectedQty, loaded, extra: it.extraQty, remaining,
        });
        byBarcode.set(it.barcode, row);
      }
    }
    // In Sr No order (the order Product Master lists them in); products with no Sr No go last.
    const items = Array.from(byBarcode.values()).sort((a, b) =>
      (a.srNo ? 0 : 1) - (b.srNo ? 0 : 1)
      || (a.srNo ?? '').localeCompare(b.srNo ?? '', undefined, { numeric: true, sensitivity: 'base' })
      || a.itemName.localeCompare(b.itemName, undefined, { numeric: true, sensitivity: 'base' }));
    for (const row of items) row.parties.sort((a, b) => a.partyName.localeCompare(b.partyName));

    res.json({
      plant, date,
      orders: slips.length,
      parties: new Set(slips.map((s) => s.partyName)).size,
      items,
    });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to build the loading item list' });
  }
});

// GET /api/loading/order-suggest?q=&plant=&date= — order numbers matching what was typed in Load
// Master's order box. Narrowed the same way the page is: to the chosen plant (refused if the user
// has no access to it), or — with "All plants" — to the plants this user may see; and to the chosen
// order date when one is picked.
router.get('/loading/order-suggest', requirePageAccess(['loading-overview', 'scan-viewer']), async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim().replace(/^#/, '');
    if (q.length < 2) return res.json([]);
    const plant = String(req.query.plant ?? '').trim();
    const date = String(req.query.date ?? '').trim();
    const userPlants = getUserPlants(req.user);
    const params: any[] = [`%${q.toLowerCase()}%`];
    const conds: string[] = ['LOWER(order_number) LIKE $1'];
    if (plant && plant !== '__all__') {
      if (!canAccessPlant(req, plant)) return res.status(403).json({ message: 'You can not access this plant — your account is restricted to the plant(s) assigned to you.' });
      params.push(plant); conds.push(`LOWER(plant) = LOWER($${params.length})`);
    } else if (userPlants !== null) {
      params.push(userPlants); conds.push(`LOWER(plant) = ANY($${params.length})`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) { params.push(date); conds.push(`order_date = $${params.length}::date`); }
    const { rows } = await pool.query(
      `SELECT order_number AS "orderNumber", party_name AS "partyName", plant, to_char(order_date, 'YYYY-MM-DD') AS "orderDate"
         FROM proforma_slips WHERE ${conds.join(' AND ')}
         ORDER BY order_date DESC NULLS LAST, order_number DESC LIMIT 15`,
      params,
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to search orders' });
  }
});

// GET /api/loading/date-slips?plant=&date= — Load Master's slip list: EVERY proforma slip of one
// order date (not only the ones a load was already started for), with its load progress, so each can
// be opened in Load Operations. Plant rules are the same as /loading/date-items.
router.get('/loading/date-slips', requirePageAccess(['loading-overview', 'scan-viewer']), async (req: Request, res: Response) => {
  try {
    const plant = String(req.query.plant ?? '').trim();
    const date = String(req.query.date ?? '').trim();
    if (!plant || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'plant and date (YYYY-MM-DD) are required' });
    const allPlants = plant === '__all__';
    if (!allPlants && !canAccessPlant(req, plant)) {
      return res.status(403).json({ message: 'You can not access this plant — your account is restricted to the plant(s) assigned to you.' });
    }
    const userPlants = getUserPlants(req.user);
    const params: any[] = [date];
    const conds: string[] = ['ps.order_date = $1::date'];
    if (!allPlants) { params.push(plant); conds.push(`LOWER(ps.plant) = LOWER($${params.length})`); }
    else if (userPlants !== null) { params.push(userPlants); conds.push(`LOWER(ps.plant) = ANY($${params.length})`); }
    const { rows } = await pool.query(
      `SELECT ps.id, ps.order_number AS "orderNumber", ps.party_name AS "partyName", ps.plant,
              ps.vehicle_number AS "vehicleNumber", ps.notion_status AS "notionStatus",
              ps.loading_completed_at AS "loadingCompletedAt", ps.loading_owner_name AS "loadingOwnerName",
              ps.loading_paused_at AS "loadingPausedAt", ps.loading_stv AS "loadingStv",
              EXISTS (SELECT 1 FROM loading_records lr WHERE lr.order_number = ps.order_number) AS "hasLoad",
              COALESCE((SELECT SUM(i.quantity) FROM proforma_slip_items i WHERE i.proforma_slip_id = ps.id), 0)::int AS "totalQty",
              COALESCE((SELECT SUM(e.total_qty) FROM loading_scan_events e WHERE e.order_number = ps.order_number AND e.voided IS NOT TRUE), 0)::int AS "loadedQty",
              CASE WHEN ps.total_volume ~ '^[0-9]+([.][0-9]+)?$' THEN ps.total_volume::numeric ELSE NULL END::float AS "orderVolume",
              COALESCE((
                SELECT SUM(ev.q * iv.vol)
                FROM (SELECT barcode, SUM(total_qty) AS q FROM loading_scan_events
                       WHERE order_number = ps.order_number AND voided IS NOT TRUE GROUP BY barcode) ev
                JOIN LATERAL (
                  SELECT CASE WHEN i.volume_in_cu_ft ~ '^[0-9]+([.][0-9]+)?$' THEN i.volume_in_cu_ft::numeric ELSE 0 END AS vol
                  FROM proforma_slip_items i WHERE i.proforma_slip_id = ps.id AND i.barcode = ev.barcode LIMIT 1
                ) iv ON TRUE
              ), 0)::float AS "loadedVolume"
         FROM proforma_slips ps
         WHERE ${conds.join(' AND ')}
         ORDER BY ps.plant, ps.order_number`,
      params,
    );
    res.json({ plant, date, slips: rows });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to load the slips' });
  }
});

// GET /api/loading/master/slip/:orderNumber — Load Master's read-only view of one slip: header, items
// with their progress, and the load's scan history. Needs only the Load Master page, not Load
// Operations; plant-scoped; no ownership rules (it is a view). `canWrite` tells the page whether to
// offer the void / remove / delete actions.
router.get('/loading/master/slip/:orderNumber', requirePageAccess(['loading-overview']), async (req: Request, res: Response) => {
  try {
    const slip: any = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) {
      return res.status(403).json({ message: 'You can not open this slip — it belongs to a plant your account is restricted from (plant restriction).' });
    }
    const rawItems = await storage.getProformaSlipItems(slip.id);
    const [progress, slipOut, eventsRes, recordRes] = await Promise.all([
      withProgress(slip, rawItems),
      withRto(slip),
      pool.query(
        `SELECT id, barcode, item_name AS "itemName", total_qty AS "totalQty", COALESCE(is_extra, false) AS "isExtra",
                COALESCE(is_adjust, false) AS "isAdjust", COALESCE(voided, false) AS voided, void_reason AS "voidReason",
                voided_at AS "voidedAt", scanned_by_name AS "scannedByName", scanned_at AS "scannedAt", stv
           FROM loading_scan_events
          WHERE order_number = $1 AND NOT COALESCE(hidden_in_history, false)
          ORDER BY scanned_at DESC, id DESC LIMIT 1500`,
        [slip.orderNumber],
      ),
      pool.query(`SELECT 1 FROM loading_records WHERE order_number = $1 LIMIT 1`, [slip.orderNumber]),
    ]);
    res.json({
      slip: slipOut, items: progress.items, allComplete: progress.allComplete, loadedVolume: progress.loadedVolume,
      hasLoad: recordRes.rows.length > 0, events: eventsRes.rows,
      canWrite: isAdmin(req) || hasWriteAccess(req.user, 'loading-overview'),
    });
  } catch (error) {
    console.error('Error loading the Load Master slip view:', error);
    res.status(500).json({ message: 'Failed to load the slip' });
  }
});

// POST /api/loading/master/events/:id/remove — take a VOIDED scan out of the slip's history list. The
// row stays in the database (stock and totals read it), it is only hidden — the same rule Scan
// History's Remove entry follows. A live scan must be voided first.
router.post('/loading/master/events/:id/remove', requireLoadMasterWrite, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid event ID' });
    const { rows } = await pool.query(`SELECT order_number, plant, barcode, voided FROM loading_scan_events WHERE id = $1`, [id]);
    const ev = rows[0];
    if (!ev) return res.status(404).json({ message: 'Load event not found' });
    if (!canAccessPlant(req, ev.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    if (!ev.voided) return res.status(409).json({ message: 'Only a voided scan can be removed from history — void it first.' });
    await pool.query(`UPDATE loading_scan_events SET hidden_in_history = true WHERE id = $1`, [id]);
    const { userCode, userName } = actor(req);
    try {
      await storage.logActivity({
        pageName: 'Load Master', action: 'delete', entityType: 'scan_history_entry', entityId: id,
        details: `Removed a voided scan from the history of order ${ev.order_number} (${ev.barcode ?? 'no barcode'}, ${ev.plant ?? ''}) by ${userName ?? userCode}`,
        userCode, userName,
      });
    } catch (e) { console.error('[Load Master] could not write the Activity entry:', e instanceof Error ? e.message : e); }
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing a load event from history:', error);
    res.status(500).json({ message: 'Failed to remove the entry' });
  }
});

router.get('/loading/records', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const limit  = Math.max(1, Math.min(100, parseInt(String(req.query.limit  ?? '20'), 10) || 20));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    // Every filter the landing list's toolbar exposes (date/search/plant picker, SLIPS/LOADING/
    // READY≈DESP tab) is applied HERE, in SQL, before COUNT and LIMIT/OFFSET — not client-side
    // over whichever one page of rows happened to already be fetched. Filtering only the loaded
    // page is what made the date filter look broken (a matching row two pages back just never
    // got far enough to be checked) and made the stat tiles never move (they summed the same
    // unfiltered page no matter what was picked). Excel-style column filters stay client-side —
    // a smaller, known limitation, not what was reported broken.
    const dateParam = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateParam);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const plantsParam = typeof req.query.plants === 'string' ? req.query.plants.trim() : '';
    const selectedPlants = plantsParam ? plantsParam.split(',').map((p) => p.trim()).filter(Boolean) : [];
    const tab = typeof req.query.tab === 'string' ? req.query.tab : 'overall';

    // Plant-scoped, same as everywhere else (unloading.ts's canAccessPlant/getUserPlants) —
    // "list available to all" only ever meant all USERS, not all plants; a user with no access
    // to a plant still shouldn't see that plant's loads here.
    const userPlants = getUserPlants(req.user);
    // One row per order, always — if a duplicate loading_records row ever exists (older data from
    // before link-vehicle was serialized), only the first one is listed, counted and totalled.
    const baseConditions: string[] = [
      `lr.id = (SELECT MIN(d.id) FROM loading_records d WHERE d.order_number = lr.order_number)`,
    ];
    const params: any[] = [];
    if (userPlants !== null) {
      params.push(userPlants);
      baseConditions.push(`LOWER(lr.plant) = ANY($${params.length})`);
    }
    if (selectedPlants.length > 0) {
      params.push(selectedPlants.map((p) => p.toLowerCase()));
      baseConditions.push(`LOWER(lr.plant) = ANY($${params.length})`);
    }
    if (dateMatch) {
      // Matches the proforma slip's own Order Date (ps.order_date, a plain `date` column — no
      // time/timezone component to shift), not Load Date (lr.created_at, when the load operation
      // itself was started) — the top calendar filter is about the ORDER's date, same as every
      // other "Order Date" column on this page. Load Date still has its own Excel column filter.
      params.push(dateParam);
      baseConditions.push(`ps.order_date = $${params.length}::date`);
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const idx = params.length;
      baseConditions.push(
        `(LOWER(lr.order_number) LIKE $${idx} OR LOWER(lr.party_name) LIKE $${idx} OR ` +
        `LOWER(lr.plant) LIKE $${idx} OR LOWER(lr.vehicle_number) LIKE $${idx} OR ` +
        `LOWER(lr.rto_number) LIKE $${idx} OR LOWER(ps.loading_stv) LIKE $${idx} OR ` +
        `LOWER(ps.loading_owner_name) LIKE $${idx})`,
      );
    }
    // "My Slips" — the one-click button, one row per order so the person's OWN link-vehicle
    // action is what counts as "created by them", same identity link-vehicle already stamps.
    if (req.query.createdBy === 'me') {
      const { userCode } = actor(req);
      if (userCode) {
        params.push(userCode);
        baseConditions.push(`lr.created_by_code = $${params.length}`);
      }
    }
    const baseWhere = baseConditions.length > 0 ? `WHERE ${baseConditions.join(' AND ')}` : '';

    const statusCondition = tab === 'loading' ? 'ps.loading_completed_at IS NULL'
      : tab === 'ready-desp' ? 'ps.loading_completed_at IS NOT NULL'
      : null;
    const listWhere = statusCondition
      ? `${baseWhere ? `${baseWhere} AND` : 'WHERE'} ${statusCondition}`
      : baseWhere;
    const listParams = [...params];
    params.push(limit, offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const [dataRes, totalRes, loadingCountRes, readyDespCountRes] = await Promise.all([
      pool.query(
        `SELECT lr.id, lr.order_number AS "orderNumber", lr.proforma_slip_id AS "proformaSlipId",
                lr.party_name AS "partyName", lr.plant, lr.vehicle_number AS "vehicleNumber",
                lr.rto_number AS "rtoNumber", lr.volume, lr.created_by_code AS "createdByCode",
                lr.created_by_name AS "createdByName", lr.created_at AS "createdAt",
                -- ::text — see the identical cast + comment on the /proforma/search query above;
                -- same raw pool.query date-shift bug, same fix.
                ps.order_date::text AS "orderDate",
                ps.loading_completed_at AS "loadingCompletedAt",
                ps.loading_completed_by_code AS "loadingCompletedByCode",
                CASE WHEN ps.loading_completed_by_code = 'system' THEN 'System' ELSE (SELECT u.name FROM users u WHERE u.user_code = ps.loading_completed_by_code LIMIT 1) END AS "loadingCompletedByName",
                ps.loading_owner_code AS "loadingOwnerCode", ps.loading_owner_name AS "loadingOwnerName",
                ps.loading_paused_at AS "loadingPausedAt",
                ps.loading_stv AS "loadingStv",
                COALESCE((SELECT SUM(i.quantity) FROM proforma_slip_items i WHERE i.proforma_slip_id = ps.id), 0)::int AS "totalQty",
                COALESCE((SELECT SUM(e.total_qty) FROM loading_scan_events e WHERE e.order_number = lr.order_number AND e.voided IS NOT TRUE), 0)::int AS "loadedQty",
                -- When the first box was really scanned. A load row created later than its own work (rows
                -- written in a batch afterwards) would otherwise give a negative Time Taken.
                (SELECT MIN(e.scanned_at) FROM loading_scan_events e WHERE e.order_number = lr.order_number AND e.voided IS NOT TRUE) AS "firstScanAt",
                -- The order's own cargo volume, and how much of it is on the vehicle so far: each
                -- barcode's loaded quantity times that item's own volume (same sum the open load
                -- screen shows). Non-numeric/blank volumes count as 0.
                CASE WHEN ps.total_volume ~ '^[0-9]+([.][0-9]+)?$' THEN ps.total_volume::numeric ELSE NULL END::float AS "orderVolume",
                COALESCE((
                  SELECT SUM(ev.q * iv.vol)
                  FROM (SELECT barcode, SUM(total_qty) AS q FROM loading_scan_events
                         WHERE order_number = lr.order_number AND voided IS NOT TRUE GROUP BY barcode) ev
                  JOIN LATERAL (
                    SELECT CASE WHEN i.volume_in_cu_ft ~ '^[0-9]+([.][0-9]+)?$' THEN i.volume_in_cu_ft::numeric ELSE 0 END AS vol
                    FROM proforma_slip_items i WHERE i.proforma_slip_id = ps.id AND i.barcode = ev.barcode LIMIT 1
                  ) iv ON TRUE
                ), 0)::float AS "loadedVolume"
         FROM loading_records lr
         LEFT JOIN proforma_slips ps ON ps.order_number = lr.order_number
         ${listWhere}
         ORDER BY ${tab === 'ready-desp' ? 'ps.loading_completed_at DESC NULLS LAST, ' : ''}lr.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM loading_records lr LEFT JOIN proforma_slips ps ON ps.order_number = lr.order_number ${listWhere}`,
        listParams,
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM loading_records lr LEFT JOIN proforma_slips ps ON ps.order_number = lr.order_number ${baseWhere ? `${baseWhere} AND ps.loading_completed_at IS NULL` : 'WHERE ps.loading_completed_at IS NULL'}`,
        listParams,
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM loading_records lr LEFT JOIN proforma_slips ps ON ps.order_number = lr.order_number ${baseWhere ? `${baseWhere} AND ps.loading_completed_at IS NOT NULL` : 'WHERE ps.loading_completed_at IS NOT NULL'}`,
        listParams,
      ),
    ]);

    const loadingCount = parseInt(loadingCountRes.rows[0]?.total ?? '0', 10);
    const readyDespCount = parseInt(readyDespCountRes.rows[0]?.total ?? '0', 10);

    res.json({
      records: dataRes.rows,
      total: parseInt(totalRes.rows[0]?.total ?? '0', 10),
      // Counts for the SLIPS/LOADING/READY≈DESP tiles — scoped to the date/search/plant filter
      // currently applied, but deliberately NOT to the tab itself, since all three tiles need to
      // stay visible (and clickable, to switch tabs) at once.
      slipsCount: loadingCount + readyDespCount,
      loadingCount,
      readyDespCount,
      limit, offset,
    });
  } catch (error) {
    console.error('Error listing loading records:', error);
    res.status(500).json({ message: 'Failed to fetch loading records' });
  }
});

// GET /api/loading/my-active-slips — every slip the current user owns that's still LOADING
// (not completed) — lightweight, just enough to label a tab. Powers the tab strip that lets
// someone switch directly between several slips they're juggling at once, instead of going back
// to the landing list each time (a user isn't restricted to owning just one active load — see
// the ownership checks elsewhere in this file, which are all scoped per-load, never globally).
router.get('/loading/my-active-slips', requirePageAccess('loading'), async (req: Request, res: Response) => {
  try {
    const { userCode } = actor(req);
    if (!userCode) return res.json({ slips: [] });
    const { rows } = await pool.query(
      `SELECT order_number AS "orderNumber", vehicle_number AS "vehicleNumber",
              party_name AS "partyName", plant
       FROM proforma_slips
       WHERE loading_owner_code = $1 AND loading_completed_at IS NULL AND UPPER(notion_status) = $2
       ORDER BY order_date DESC`,
      [userCode, NOTION_LOADING_STATUS],
    );
    res.json({ slips: rows });
  } catch (error) {
    console.error('Error listing active slips:', error);
    res.status(500).json({ message: 'Failed to load active slips' });
  }
});

// POST /api/loading/proforma/:orderNumber/link-vehicle  — body: { vehicleId } (preferred) or
// { vehicleNumber } (fallback, for older callers).
// Writes vehicleNumber + totalVolume (from Vehicle Master) onto the proforma slip, along with
// vehicleInfoId — the EXACT row linked, since vehicleNumber alone stopped being unique once
// Vehicle Master allowed two Notion pages to share one (identity is notionPageId now, not the
// number — see vehicleInfo's own comment in shared/schema.ts). Picking by id is what lets
// withRto (above) and any other read find the SAME row the user actually chose from the search
// dropdown, instead of a plain by-number lookup landing on a different same-numbered row.
// The FIRST assignment is open to anyone with write access to Loading; once a vehicle is
// assigned, changing it again is restricted to whoever assigned it or an admin (see
// vehicleAssignedByCode in shared/schema.ts) — enforced here, not just hidden client-side.
router.post('/loading/proforma/:orderNumber/link-vehicle', requireLoadingWrite, async (req: Request, res: Response) => {
  try {
    const vehicleId = req.body?.vehicleId != null ? Number(req.body.vehicleId) : null;
    const vehicleNumber = String(req.body?.vehicleNumber ?? '').trim();
    if (!vehicleId && !vehicleNumber) return res.status(400).json({ message: 'vehicleId or vehicleNumber is required' });

    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const { userCode, userName } = actor(req);
    const alreadyAssigned = !!slip.vehicleNumber && !!(slip as any).vehicleAssignedByCode;
    if (alreadyAssigned && !isAdmin(req) && !isSupervisor(req) && (slip as any).vehicleAssignedByCode !== userCode) {
      return res.status(403).json({ message: 'Only the person who assigned this vehicle, or an admin, can change it.' });
    }

    const vehicle = vehicleId
      ? await storage.getVehicleInfo(vehicleId)
      : await storage.getVehicleInfoByVehicleNumberOrRto(vehicleNumber);
    if (!vehicle) return res.status(404).json({ message: `No vehicle found in Vehicle Master${vehicleNumber ? ` with number "${vehicleNumber}"` : ''}` });
    // vehicleInfo.vehicleNumber is nullable (a manually-added Vehicle Master row can be saved
    // without one) — the vehicleId lookup path doesn't guarantee it's set, unlike the
    // by-vehicleNumber path. Nothing meaningful to link without it.
    if (!vehicle.vehicleNumber) return res.status(400).json({ message: 'This vehicle has no vehicle number set in Vehicle Master.' });

    const updated = await storage.updateProformaSlip(slip.id, {
      vehicleNumber: vehicle.vehicleNumber,
      vehicleInfoId: vehicle.id,
      // totalVolume is NOT touched here — it's the order's own cargo volume (Product Master's
      // per-item volumeInCuFt, summed at import/scan time), a different number from the
      // vehicle's capacity. This used to overwrite one with the other; see the capacity check
      // just below for how the two are actually meant to be compared instead.
      vehicleAssignedByCode: userCode ?? null,
      // Status is deliberately NOT touched here — a vehicle can be linked (or changed) from the
      // Create-Operation dialog before the load has actually been started, and starting it is
      // what owns the flip to LOADING (see POST /start).
    } as any);
    if (!updated) return res.status(500).json({ message: 'Failed to link vehicle to proforma slip' });

    // Informational only — never blocks linking or scanning, just surfaced to the client to warn
    // before scanning starts if the order's own required volume won't fit this vehicle.
    const orderVolume = parseFloat(updated.totalVolume ?? '');
    const vehicleCapacity = vehicle.volume != null ? Number(vehicle.volume) : null;
    const capacityWarning =
      Number.isFinite(orderVolume) && vehicleCapacity != null && orderVolume > vehicleCapacity
        ? `This order needs ${orderVolume} cu ft but ${vehicle.vehicleNumber} only holds ${vehicleCapacity} cu ft.`
        : null;

    if (userCode) {
      await storage.logActivity({
        pageName: 'Loading', action: 'update', entityType: 'proforma_slip', entityId: slip.id,
        details: `Vehicle ${vehicle.vehicleNumber} linked to order ${slip.orderNumber} by ${userName ?? userCode}`,
        userCode, userName,
      });
    }

    // This is what the Loading page's landing table lists — one row per order number.
    // Snapshotted, not a live join (see shared/schema.ts's loadingRecords comment). Re-linking
    // (a double-click on the same vehicle, or picking a different one afterwards) updates this
    // same row in place rather than inserting another one — it used to insert unconditionally,
    // which duplicated the order in the landing list every time link-vehicle ran more than once.
    // The check-then-write below runs under a per-order advisory lock in one transaction, so two
    // link-vehicle requests arriving together (a double tap, a retry) can't both find "no row yet"
    // and each insert one.
    //
    // NOT created here any more: the landing-list row is written only by POST /start (Create
    // Operation). Linking a vehicle from the Create dialog and closing it without pressing Create
    // Operation used to leave the slip in the list (and marked as already created). This only
    // keeps an ALREADY-created load's row in step with a vehicle change — creator and load date
    // are left alone, and nothing happens when no row exists yet.
    await pool.query(
      `UPDATE loading_records SET proforma_slip_id = $1, party_name = $2, plant = $3,
              vehicle_number = $4, rto_number = $5, volume = $6
       WHERE order_number = $7`,
      [updated.id, updated.partyName, updated.plant, vehicle.vehicleNumber, vehicle.rtoNumber ?? null,
       vehicle.volume != null ? String(vehicle.volume) : null, updated.orderNumber],
    );

    // Notion's Order page: point its vehicle link at this vehicle's Notion page (compare first,
    // write, confirm, retry). A vehicle that exists only in this app has no Notion page to point at.
    const notionOutcome: NotionSyncOutcome = (vehicle as any).notionPageId
      ? await settleNotionSync(syncOrderToNotion(updated.orderNumber, { vehiclePageId: (vehicle as any).notionPageId }, actor(req)))
      : { state: 'skipped', message: `${vehicle.vehicleNumber} has no Notion page, so Notion was not updated with this vehicle.` };

    // Notion's automation may change the status after a vehicle is set — two minutes from now the
    // status of a load started here is put back (Loading / Ready for Dispatch).
    // For a load with entries that is Loading again; for a slip with no entries yet it is the status the
    // slip had before this link — the link must change the vehicle only.
    void watchStatusAfterVehicleChange(updated.orderNumber, actor(req), { holdCurrentStatus: true });

    res.json({ slip: await withRto(updated), vehicle, capacityWarning, notion: notionOutcome });
  } catch (error) {
    console.error('Error linking vehicle to proforma slip:', error);
    res.status(500).json({ message: 'Failed to link vehicle' });
  }
});

// POST /api/loading/proforma/:orderNumber/scan  — body: { barcode, qty }
// The actual "remove stock and load it onto the vehicle" step. qty is already resolved
// client-side (pallets × itemsPerPallet + loose, or a full-pallet auto-scan amount) — this
// endpoint independently re-validates against the same rules Order Scan uses server-side.
router.post('/loading/proforma/:orderNumber/scan', requireLoadingWrite, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const barcode = String(req.body?.barcode ?? '').trim();
    const qty = Math.round(Number(req.body?.qty));
    const isExtraScan = req.body?.extra === true;
    // Set by the offline queue on every scan attempt, resent unchanged on a retry of that same
    // attempt — if this exact attempt already landed (the request reached the server before but
    // its response was lost to a flaky connection), skip re-recording it rather than double-count.
    const clientRequestId = typeof req.body?.clientRequestId === 'string' ? req.body.clientRequestId.trim() || null : null;
    // True only for a request replayed by the offline queue's flush (client/src/lib/offlineQueue.ts) —
    // see the "already complete" check just below for why that distinction matters.
    const fromOfflineQueue = req.body?.fromOfflineQueue === true;
    if (!barcode) return res.status(400).json({ message: 'barcode is required' });
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ message: 'qty must be a positive number' });
    if (clientRequestId) {
      const { rows: dupRows } = await client.query(
        `SELECT id FROM loading_scan_events WHERE order_number = $1 AND client_request_id = $2 LIMIT 1`,
        [req.params.orderNumber, clientRequestId],
      );
      if (dupRows.length > 0) {
        return res.json({ success: true, duplicate: true, message: 'Already recorded — duplicate request skipped.' });
      }
    }

    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    // A LIVE scan on an already-completed load is refused — reopen it first. But a request
    // replayed from the offline queue represents a scan physically made BEFORE the load
    // completed (the operator was offline); it only shows as complete now because another item
    // queued alongside it happened to flush first. Rejecting it here would silently discard a
    // real scan — let it through instead and record it as pure extra, same as any qty beyond
    // 100% already is.
    if ((slip as any).loadingCompletedAt && !fromOfflineQueue) {
      return res.status(409).json({ message: 'This load is already marked complete — reopen it before scanning more.' });
    }
    const ownershipError = checkLoadOwnership(slip, req, await resolveLoadOwner(slip));
    if (ownershipError) return res.status(403).json({ message: ownershipError });
    // The slip's own locked STV wins over whatever the client sent — the pick belongs to the load
    // (chosen once at Create Operation), not to the scanning session, so a stale client or an
    // older slip's remembered localStorage value can't tag events with a different platform.
    const stv = (slip as any).loadingStv
      ?? (req.body?.stv != null ? String(req.body.stv).trim() || null : null);
    // Vehicle must be linked before any item can be scanned onto it — enforced here too, not
    // just hidden client-side, so a stale/bypassed client can't scan against an unassigned slip.
    if (!slip.vehicleNumber) {
      return res.status(400).json({ message: 'Link a vehicle to this order before scanning items.' });
    }

    const rawItems = await storage.getProformaSlipItems(slip.id);
    const matchedItem = rawItems.find((i) => normalize(i.barcode) === normalize(barcode));
    const product = await storage.getProductByBarcode(barcode, slip.plant);

    // Not on this slip AND not a known product at all — same refusal Order Scan gives for a
    // barcode it has no record of whatsoever, rather than quietly logging it as an extra. Tagged
    // for matchBarcodeNotInSystemError's client-side handling (a distinct centered popup, not
    // the ordinary error toast) in LoadOperation.tsx.
    if (!matchedItem && !product) {
      return res.status(400).json({
        message: `BARCODE_NOT_IN_SYSTEM: "${barcode}" is not on this order and not in Product Master. It cannot be scanned.`,
      });
    }
    // On the order, but nothing in Product Master to back it — item name/SAP code would
    // silently fall back to the order's own text and pallet size to a generic default instead of
    // the real GJ/MP-PLT value. Blocked rather than allowed through quietly. See
    // PRODUCT_MASTER_MISSING's client-side handling (a distinct centered popup, not the ordinary
    // error toast) in LoadOperation.tsx.
    if (matchedItem && !product) {
      return res.status(400).json({
        message: `PRODUCT_MASTER_MISSING: Barcode "${barcode}" is not in the system — it's on this order but doesn't exactly match anything in Product Master (often a formatting difference, like a missing leading zero). Fix it by editing the CSV/order to use the correct barcode.`,
      });
    }

    // Fast, UNLOCKED pre-check — just to fail obviously-bad requests (no stock at all) quickly
    // and cheaply, before touching a transaction. NOT authoritative: two concurrent scans of the
    // same barcode/plant could both read the same snapshot here and both pass. The real check
    // (below, inside the transaction, against FOR UPDATE-locked rows) is what actually prevents
    // stock from going negative when multiple scans happen at once. Pooled across every plant in
    // slip.plant's state (see server/lib/statePool.ts) — e.g. loading at Valsad can draw on
    // stock physically sitting at Vadodra too, since both are "Gj".
    const { total: precheckPooled } = await getPooledStock(client, barcode, slip.plant ?? '');
    if (precheckPooled <= 0) {
      return res.status(409).json({ message: `No stock available to load "${matchedItem?.itemName ?? product?.name ?? barcode}" at ${slip.plant} — current stock is 0.` });
    }

    // Same itemsPerPallet the Items table already shows for this row (withProgress uses the
    // identical resolvePalletSizeOrQty(product, state, expected) call) — so a scan's pallets/
    // loose split here always agrees with what the page displays, and with how Order Scan
    // splits its own events (server/routes/order-scan.ts's writeScanEvents). Doesn't depend on
    // anything that can change between now and the lock below, so it's safe to resolve early.
    const expected = matchedItem?.quantity ?? 0;
    const state = await getPlantStateCode(client, slip.plant ?? '');
    const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, expected);

    const { userCode, userName } = actor(req);
    // Assigned inside the locked section below, but needed afterward too (for the response) —
    // declared here so both sides of the transaction boundary can see them.
    let regularQty = 0;
    let extraQty = 0;
    let remainingBefore = 0;
    await client.query('BEGIN');
    try {
      // Lock every same-state plant's stock row for this barcode FIRST, before re-checking or
      // touching anything else that depends on the current stock/loaded totals — this is what
      // actually serializes concurrent scans of the same barcode across this whole state pool
      // (from this order or any other, at slip.plant or a sibling same-state plant) so a second
      // request has to wait for the first to commit, then sees its real, post-commit numbers
      // instead of racing against a stale snapshot taken before either transaction started.
      // Debits the FULL qty here (own plant first, then other same-state plants — see
      // debitStatePool) — the regular/extra split just below is a bookkeeping label on top of
      // the same already-decremented physical stock, not a separate stock action.
      const contributions = await debitStatePool(client, barcode, slip.plant ?? '', qty, product?.id);

      // Same "split into a regular portion (capped at expected) + an extra portion" rule Order
      // Scan uses (server/routes/order-scan.ts) — a single scan can legitimately be part
      // regular, part extra, e.g. expected 10 / already loaded 8 / scanning 5 → 2 regular + 3
      // extra. Re-read fresh, now that the stock row above is locked, so two concurrent scans of
      // the same order+barcode can't both see the same stale "already loaded" and both think
      // they're entirely regular.
      const { rows: loadedRows } = await client.query(
        `SELECT COALESCE(SUM(total_qty), 0)::int AS "loaded" FROM loading_scan_events
         WHERE order_number = $1 AND barcode = $2 AND voided IS NOT TRUE`,
        [slip.orderNumber, barcode],
      );
      const alreadyLoaded = loadedRows[0]?.loaded ?? 0;
      remainingBefore = matchedItem ? Math.max(0, expected - alreadyLoaded) : 0;
      // The Add Extra flow is a deliberate, explicit "log this as extra" action — the whole qty
      // is extra even if the item still has room left in `remaining`, not just whatever spills
      // past it. A regular scan keeps the ordinary split (capped at what's remaining; see the
      // EXTRA_NOT_ALLOWED check right below, which refuses it whenever that split would leave any
      // extra portion at all).
      regularQty = (matchedItem && !isExtraScan) ? Math.min(qty, remainingBefore) : 0;
      extraQty = qty - regularQty;

      // Extra only after the item is complete: an item that IS on this order and still has
      // quantity left must be loaded up to its expected quantity first — otherwise the "extra"
      // would just stand in for boxes the order still needs and be counted twice (as Extra and as
      // loaded). An item not on the order at all is always fine. A replayed offline scan skips
      // this like the check below does.
      if (isExtraScan && matchedItem && remainingBefore > 0 && !fromOfflineQueue) {
        throw Object.assign(new Error(
          `EXTRA_NOT_ALLOWED: Only ${remainingBefore} left to load for "${matchedItem.itemName ?? barcode}". Load those first, then add the Extra.`,
        ), { status: 400 });
      }

      // Extra quantity (barcode not on this slip at all, or qty beyond what's still remaining
      // for it) can only be logged through the dedicated Add Extra flow, never a regular scan —
      // tagged for matchExtraNotAllowedError's client-side handling (a distinct centered popup)
      // in LoadOperation.tsx. The Add Extra flow sends extra:true and skips this check entirely.
      // A replayed offline scan skips it too, for the same reason the "already complete" check
      // above does: it can't be sent back to prompt the operator to pick Add Extra instead —
      // the physical scan already happened while still genuinely regular, and by the time this
      // replay runs, an earlier item in the same offline batch may have used up what was
      // remaining. Recording it as extra automatically beats losing it.
      if (!isExtraScan && !fromOfflineQueue && extraQty > 0) {
        throw Object.assign(new Error(matchedItem
          ? `EXTRA_NOT_ALLOWED: Only ${remainingBefore} left to load for "${matchedItem.itemName ?? barcode}" — scanning ${qty} would add ${extraQty} extra. Use Add Extra for the extra quantity.`
          : `EXTRA_NOT_ALLOWED: "${barcode}" is not on this order. Use Add Extra to scan it.`), { status: 400 });
      }

      // clientRequestId is recorded on only the FIRST of the (up to two) rows this attempt
      // produces — the duplicate check above only needs to find one row to know this attempt
      // already landed, and the unique index backing it is one-id-per-table, not per-row-of-a-
      // split-scan.
      let requestIdRecorded = false;
      const insertEvent = async (totalQty: number, isExtra: boolean): Promise<number> => {
        const idForThisRow = requestIdRecorded ? null : clientRequestId;
        requestIdRecorded = true;
        const { rows: insertedRows } = await client.query(
          `INSERT INTO loading_scan_events
             (order_number, proforma_slip_id, barcode, item_name, sap_code, pallets, loose_qty, total_qty, is_extra, plant, stv, scanned_by_code, scanned_by_name, client_request_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [
            slip.orderNumber, slip.id, barcode, matchedItem?.itemName ?? product?.name ?? null, matchedItem?.sapCode ?? product?.sapCode ?? null,
            itemsPerPallet > 0 ? Math.floor(totalQty / itemsPerPallet) : 0,
            itemsPerPallet > 0 ? totalQty % itemsPerPallet : totalQty,
            totalQty, isExtra, slip.plant, stv, userCode ?? null, userName ?? null, idForThisRow,
          ],
        );
        return insertedRows[0].id as number;
      };
      // The regular/extra split above is a bookkeeping label on top of the single debit already
      // taken from `contributions` — slice that same pool of per-plant amounts across whichever
      // event(s) get inserted, in contribution order, so each event's own loading_stock_pulls
      // rows sum to exactly its own total_qty (needed for an exact per-event void later).
      let sliceRemaining = regularQty;
      const regularContributions: StockPullContribution[] = [];
      const extraContributions: StockPullContribution[] = [];
      for (const c of contributions) {
        if (sliceRemaining <= 0) { extraContributions.push(c); continue; }
        if (c.qty <= sliceRemaining) { regularContributions.push(c); sliceRemaining -= c.qty; }
        else {
          regularContributions.push({ plant: c.plant, qty: sliceRemaining });
          extraContributions.push({ plant: c.plant, qty: c.qty - sliceRemaining });
          sliceRemaining = 0;
        }
      }
      if (regularQty > 0) {
        const id = await insertEvent(regularQty, false);
        await recordStockPulls(client, id, regularContributions);
      }
      if (extraQty > 0) {
        const id = await insertEvent(extraQty, true);
        await recordStockPulls(client, id, extraContributions);
      }

      // One stock_movements row per plant the stock actually came from (was always exactly one
      // row, against slip.plant, before pooling — now it's one per contributing plant so the
      // audit trail/Overall Stock history stays correct for whichever plant physically lost it).
      // extra_qty is this plant's own share of extraContributions, not the scan's full extraQty
      // — putting the whole extraQty on every row would double (or more) count it wherever
      // stock_movements.extra_qty gets summed, once pooling spans more than one plant.
      const extraQtyByPlant = new Map<string, number>();
      for (const c of extraContributions) extraQtyByPlant.set(c.plant, (extraQtyByPlant.get(c.plant) ?? 0) + c.qty);
      for (const c of contributions) {
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
           VALUES ($1,$2,$3,$4,$5,'dispatch',$6,$7,'loading')`,
          [
            barcode, product?.id ?? null, c.plant, -c.qty, extraQtyByPlant.get(c.plant) ?? 0,
            c.plant === slip.plant
              ? `Loaded onto vehicle for order ${slip.orderNumber}`
              : `Loaded onto vehicle for order ${slip.orderNumber} (pooled from ${c.plant} for ${slip.plant})`,
            userCode ?? null,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    const { items: progressItems, allComplete, loadedVolume } = await withProgress(slip, rawItems);

    let finalSlip: any = slip;
    // A load is never completed automatically — someone has to press Complete.
    // The first entry turns the status to LOADING; show it in this very response.
    if (await ensureLoadingOnEntry(slip, actor(req))) finalSlip = { ...slip, notionStatus: NOTION_LOADING_STATUS };

    res.json({
      slip: await withRto(finalSlip), items: progressItems, allComplete, loadedVolume,
      event: {
        barcode, itemName: matchedItem?.itemName ?? product?.name ?? barcode,
        sapCode: matchedItem?.sapCode ?? product?.sapCode ?? null,
        totalQty: qty, isExtra: extraQty > 0, remaining: Math.max(0, remainingBefore - regularQty),
        productId: product?.id ?? null,
      },
    });

    // Best-effort, after the response — only when this scan is what just auto-completed it.
    if (allComplete && (finalSlip as any).loadingCompletedAt && !(slip as any).loadingCompletedAt) {
      void syncOrderToNotion(slip.orderNumber, { status: NOTION_LOADING_COMPLETE_STATUS }, actor(req));
    }
  } catch (error: any) {
    // A rejection raised from inside the locked transaction above (stock/extra checks re-run
    // against the FOR UPDATE-locked row) carries its own intended status — an expected business
    // rejection, not a server error, so it shouldn't be logged as one or masked as a 500.
    if (error?.status) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error('Error scanning item for loading:', error);
    res.status(500).json({ message: 'Failed to record scan' });
  } finally {
    client.release();
  }
});

// POST /api/loading/proforma/:orderNumber/adjust-load — body: { barcode, delta }
// The Items table's own +/- buttons: a manual correction to one item's loaded quantity, instead
// of going through the barcode scanner. Same write access as a normal scan (requirePageWrite
// below) — not admin-only. Always recorded as its own loading_scan_events row (delta's sign and
// all), so it shows up in scan history exactly like a real scan, just distinguishable by having
// come from here rather than a barcode. Deliberately skips the regular/extra "remaining" cap the
// real scan enforces (EXTRA_NOT_ALLOWED) — this is an explicit correction tool the operator chose
// to use, not an accidental over-scan, so it's always allowed as long as stock/loaded bounds
// themselves aren't violated (checked below, under the same FOR UPDATE lock /scan uses).
router.post('/loading/proforma/:orderNumber/adjust-load', requireLoadingWrite, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const barcode = String(req.body?.barcode ?? '').trim();
    const delta = Math.round(Number(req.body?.delta));
    if (!barcode) return res.status(400).json({ message: 'barcode is required' });
    if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ message: 'delta must be a non-zero number' });

    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    if ((slip as any).loadingCompletedAt) {
      return res.status(409).json({ message: 'This load is already marked complete — reopen it before adjusting it.' });
    }
    const ownershipError = checkLoadOwnership(slip, req, await resolveLoadOwner(slip));
    if (ownershipError) return res.status(403).json({ message: ownershipError });
    if (!slip.vehicleNumber) {
      return res.status(400).json({ message: 'Link a vehicle to this order before adjusting items.' });
    }

    const rawItems = await storage.getProformaSlipItems(slip.id);
    const matchedItem = rawItems.find((i) => normalize(i.barcode) === normalize(barcode));
    const product = await storage.getProductByBarcode(barcode, slip.plant);
    const expected = matchedItem?.quantity ?? 0;
    const state = await getPlantStateCode(client, slip.plant ?? '');
    const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, expected);
    const { userCode, userName } = actor(req);

    let newLoadedTotal = 0;
    await client.query('BEGIN');
    try {
      // A positive delta is a fresh debit — pools across slip.plant's state the same way /scan
      // does (see server/lib/statePool.ts). A negative delta corrects the running total down
      // rather than reversing one specific earlier pull, so — unlike /scan, void and qty-edit
      // above — it always credits back to slip.plant's own row, same as before pooling existed.
      // A state-pool credit here would need to unwind pulls across possibly several earlier
      // events, which this simple +/- correction tool deliberately doesn't attempt.
      let positiveDeltaContributions: StockPullContribution[] = [];
      if (delta > 0) {
        try {
          positiveDeltaContributions = await debitStatePool(client, barcode, slip.plant ?? '', delta, product?.id);
        } catch (err: any) {
          throw Object.assign(new Error(err?.message ?? `Cannot add ${delta}.`), { status: err?.status ?? 409 });
        }
      }

      const { rows: loadedRows } = await client.query(
        `SELECT COALESCE(SUM(total_qty), 0)::int AS "loaded" FROM loading_scan_events
         WHERE order_number = $1 AND barcode = $2 AND voided IS NOT TRUE`,
        [slip.orderNumber, barcode],
      );
      const alreadyLoaded = loadedRows[0]?.loaded ?? 0;
      newLoadedTotal = alreadyLoaded + delta;
      if (newLoadedTotal < 0) {
        throw Object.assign(new Error(`Only ${alreadyLoaded} currently loaded for this item — cannot remove ${Math.abs(delta)}.`), { status: 409 });
      }

      // Split the change into the part that is NORMAL (up to the expected quantity) and the part that
      // is EXTRA (beyond it), the same way a scan does — so a "+" that crosses the expected quantity
      // is only partly Extra, and a "−" takes boxes off the Extra first and only then off the normal
      // part. Extra = Loaded − Expected then stays true whatever order the buttons were pressed in.
      const absDelta = Math.abs(delta);
      const room = Math.max(0, expected - alreadyLoaded);          // how much more is still "normal"
      const aboveExpected = Math.max(0, alreadyLoaded - expected); // how much is already Extra
      const extraPart = delta > 0 ? Math.max(0, delta - room) : Math.min(absDelta, aboveExpected);
      const regularPart = absDelta - extraPart;
      const sign = delta > 0 ? 1 : -1;
      const insertAdjust = async (qtyAbs: number, isExtra: boolean): Promise<number> => {
        const { rows } = await client.query(
          `INSERT INTO loading_scan_events
             (order_number, proforma_slip_id, barcode, item_name, sap_code, pallets, loose_qty, total_qty, is_extra, is_adjust, plant, stv, scanned_by_code, scanned_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$13) RETURNING id`,
          [
            slip.orderNumber, slip.id, barcode, matchedItem?.itemName ?? product?.name ?? null, matchedItem?.sapCode ?? product?.sapCode ?? null,
            sign * (itemsPerPallet > 0 ? Math.floor(qtyAbs / itemsPerPallet) : 0),
            sign * (itemsPerPallet > 0 ? qtyAbs % itemsPerPallet : qtyAbs),
            sign * qtyAbs, isExtra, slip.plant, null, userCode ?? null, userName ?? null,
          ],
        );
        return rows[0].id as number;
      };
      const regularEventId = regularPart > 0 ? await insertAdjust(regularPart, false) : null;
      const extraEventId = extraPart > 0 ? await insertAdjust(extraPart, true) : null;

      if (delta > 0) {
        // Slice the stock pulled across the event(s), normal part first (same as a scan), so each
        // event's own pulls add up to exactly its own quantity — needed for an exact void later.
        let sliceRemaining = regularPart;
        const regularContributions: StockPullContribution[] = [];
        const extraContributions: StockPullContribution[] = [];
        for (const c of positiveDeltaContributions) {
          if (sliceRemaining <= 0) { extraContributions.push(c); continue; }
          if (c.qty <= sliceRemaining) { regularContributions.push(c); sliceRemaining -= c.qty; }
          else {
            regularContributions.push({ plant: c.plant, qty: sliceRemaining });
            extraContributions.push({ plant: c.plant, qty: c.qty - sliceRemaining });
            sliceRemaining = 0;
          }
        }
        if (regularEventId) await recordStockPulls(client, regularEventId, regularContributions);
        if (extraEventId) await recordStockPulls(client, extraEventId, extraContributions);
        for (const c of positiveDeltaContributions) {
          await client.query(
            `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
             VALUES ($1,$2,$3,$4,0,'adjust',$5,$6,'loading')`,
            [
              barcode, product?.id ?? null, c.plant, -c.qty,
              c.plant === slip.plant
                ? `Loaded quantity manually increased by ${delta} for order ${slip.orderNumber}`
                : `Loaded quantity manually increased by ${delta} for order ${slip.orderNumber} (pooled from ${c.plant} for ${slip.plant})`,
              userCode ?? null,
            ],
          );
        }
      } else {
        await reconcileProductPlantStockBarcode(client, product?.id, slip.plant, barcode);
        await client.query(
          `UPDATE product_plant_stock SET in_stock = in_stock - $1, updated_at = NOW() WHERE barcode = $2 AND LOWER(TRIM(plant)) = LOWER(TRIM($3))`,
          [delta, barcode, slip.plant],
        );
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
           VALUES ($1,$2,$3,$4,0,'adjust',$5,$6,'loading')`,
          [
            barcode, product?.id ?? null, slip.plant, -delta,
            `Loaded quantity manually decreased by ${Math.abs(delta)} for order ${slip.orderNumber}`,
            userCode ?? null,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    const { items: progressItems, allComplete, loadedVolume } = await withProgress(slip, rawItems);
    let finalSlip: any = slip;
    // A load is never completed automatically — someone has to press Complete.
    // The first entry turns the status to LOADING; show it in this very response.
    if (await ensureLoadingOnEntry(slip, actor(req))) finalSlip = { ...slip, notionStatus: NOTION_LOADING_STATUS };

    res.json({
      slip: await withRto(finalSlip), items: progressItems, allComplete, loadedVolume,
      event: {
        barcode, itemName: matchedItem?.itemName ?? product?.name ?? barcode,
        sapCode: matchedItem?.sapCode ?? product?.sapCode ?? null,
        totalQty: delta, isExtra: newLoadedTotal > expected, remaining: Math.max(0, expected - newLoadedTotal),
        productId: product?.id ?? null,
      },
    });
    if (allComplete && (finalSlip as any).loadingCompletedAt && !(slip as any).loadingCompletedAt) {
      void syncOrderToNotion(slip.orderNumber, { status: NOTION_LOADING_COMPLETE_STATUS }, actor(req));
    }
  } catch (error: any) {
    if (error?.status) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error('Error adjusting loaded quantity:', error);
    res.status(500).json({ message: 'Failed to adjust loaded quantity' });
  } finally {
    client.release();
  }
});

// POST /api/loading/proforma/:orderNumber/complete — manual override: works even if items are
// still short, unlike the automatic path above. Permission is resolved per-slip (see
// canCompleteLoad) rather than as route middleware, since it needs the slip's own owner/creator.
router.post('/loading/proforma/:orderNumber/complete', requireLoadingWrite, async (req: Request, res: Response) => {
  try {
    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    if (!(await canCompleteLoad(req, slip))) {
      return res.status(403).json({ message: "Only this load's creator, its current owner, or an admin/supervisor can complete it." });
    }

    const { userCode, userName } = actor(req);
    const updated = await storage.updateProformaSlip(slip.id, {
      loadingCompletedAt: new Date(), loadingCompletedByCode: userCode ?? null,
      notionStatus: NOTION_LOADING_COMPLETE_STATUS,
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
    const { items, allComplete, loadedVolume } = await withProgress(updated, rawItems);
    // Completing re-checks BOTH the status and the vehicle in Notion (the app wins for these), so a
    // load never becomes Ready for Dispatch with an out-of-date vehicle there. The first try is
    // awaited so the screen can say how it went.
    const notionOutcome = await settleNotionSync(syncOrderToNotion(
      updated.orderNumber,
      {
        status: NOTION_LOADING_COMPLETE_STATUS,
        ...(await (async () => {
          const { rows } = await pool.query(
            `SELECT v.notion_page_id AS "vehiclePage", ps.vehicle_assigned_by_code AS assigned
               FROM proforma_slips ps LEFT JOIN vehicle_info v ON v.id = ps.vehicle_info_id WHERE ps.order_number = $1`,
            [updated.orderNumber],
          );
          return rows[0]?.assigned && rows[0]?.vehiclePage ? { vehiclePageId: rows[0].vehiclePage as string } : {};
        })()),
      },
      actor(req),
    ));
    res.json({ slip: await withRto(updated), items, allComplete, loadedVolume, notion: notionOutcome });
  } catch (error) {
    console.error('Error completing load:', error);
    res.status(500).json({ message: 'Failed to complete load' });
  }
});

// POST /api/loading/proforma/:orderNumber/reopen — undoes Complete (auto or manual), same
// permission as Complete itself. Purely a status flip: clears loadingCompletedAt/By so the order
// can be scanned again; nothing else about the load (items already scanned, vehicle) is touched.
router.post('/loading/proforma/:orderNumber/reopen', requireLoadingWrite, requireReopenAccess, async (req: Request, res: Response) => {
  try {
    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    const isCurrentOwner = !!slip.loadingOwnerCode && slip.loadingOwnerCode === (req.user as any)?.userCode;
    if (!isAdmin(req) && !isSupervisor(req) && !isCurrentOwner) {
      return res.status(403).json({ message: 'Only the current owner of this load or an admin can reopen it.' });
    }

    const { userCode, userName } = actor(req);
    const updated = await storage.updateProformaSlip(slip.id, {
      loadingCompletedAt: null, loadingCompletedByCode: null,
      notionStatus: NOTION_LOADING_STATUS,
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
    const { items, allComplete, loadedVolume } = await withProgress(updated, rawItems);
    // Symmetric with completing — reopening un-does "DISPATCHED" back to "LOADING" in Notion too.
    const notionOutcome = await settleNotionSync(syncOrderToNotion(updated.orderNumber, { status: NOTION_LOADING_STATUS }, actor(req)));
    res.json({ slip: await withRto(updated), items, allComplete, loadedVolume, notion: notionOutcome });
  } catch (error) {
    console.error('Error reopening load:', error);
    res.status(500).json({ message: 'Failed to reopen load' });
  }
});

// Status a deleted load goes back to when the slip's pre-loading status was never recorded (loads
// started before status_before_loading existed): "ready to load", the step just before LOADING.
const STATUS_AFTER_DELETE_FALLBACK = 'READY≈LOAD';

// POST /api/loading/proforma/:orderNumber/reset — the landing table's "Delete" action, body
// { mode: 'void' | 'remove' } (default 'void'). Same permission as voiding a single load event.
// Both modes undo everything Loading did for this order, so the slip can go through Create
// Operation again:
//   - stock: every non-voided scan is reversed — its qty added back to product_plant_stock (a
//     negative +/- correction is taken back out, which the old reset skipped);
//   - the slip: vehicle, completion, owner, pause, STV and StoreKeeper Info are cleared, and its
//     Finny Status goes back to what it was before Create Operation (app and Notion). Leaving it
//     LOADING, as the old reset did, made Create Operation refuse the slip for good;
//   - loading_records (the landing table's own row) is deleted.
// They differ only in what's left behind:
//   'void'   — scan entries stay, marked Voided (visible in Scan History), with a correcting
//              stock ledger row each; handoff history stays.
//   'remove' — scan entries, handoff history and this order's Loading ledger rows are deleted
//              outright, as if the load never happened. Ledger rows are matched by the order
//              number in their reason; a quantity edit's rows carry no order number and stay, but
//              Loading's ledger rows are never read by any stock total or history view (those all
//              read the scan entries), so nothing shows or counts them.
// The proforma slip and its items are never touched.
const resetLoadingSlip = async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const mode: 'void' | 'remove' = req.body?.mode === 'remove' ? 'remove' : 'void';
    const slip = await storage.getProformaSlipByOrderNumber(req.params.orderNumber);
    if (!slip) return res.status(404).json({ message: 'No proforma slip found for this order number' });
    if (!canAccessPlant(req, slip.plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const { userCode, userName } = actor(req);
    const previousStatus = String((slip as any).statusBeforeLoading ?? '').trim();
    // The status before Loading was remembered at the load's first entry. A load that never had an entry never
    // changed the status, so there is nothing to undo: it keeps what it has.
    const currentStatus = String((slip as any).notionStatus ?? '').trim();
    const restoredStatus = previousStatus && previousStatus.toUpperCase() !== NOTION_LOADING_STATUS
      ? previousStatus
      : (currentStatus && currentStatus.toUpperCase() !== NOTION_LOADING_STATUS ? currentStatus : STATUS_AFTER_DELETE_FALLBACK);
    const hadNotionStoreKeeper = !!(slip as any).notionStoreKeeperPush;

    await client.query('BEGIN');

    const { rows: events } = await client.query(
      `SELECT * FROM loading_scan_events WHERE order_number = $1 AND voided IS NOT TRUE FOR UPDATE`,
      [slip.orderNumber],
    );
    for (const event of events) {
      const qty = Number(event.total_qty ?? 0);
      if (qty !== 0 && event.plant && event.barcode) {
        const product = await storage.getProductByBarcode(event.barcode, event.plant);
        // Credit back exactly whichever plant(s) this event's stock was pooled from (see
        // server/lib/statePool.ts). Falls back to the old plant-only credit for an event that
        // predates loading_stock_pulls (no rows there).
        let contributions = await reverseStockPullsForEvent(client, event.id, event.barcode);
        if (contributions.length === 0) {
          await reconcileProductPlantStockBarcode(client, product?.id, event.plant, event.barcode);
          await client.query(
            `UPDATE product_plant_stock SET in_stock = in_stock + $1, updated_at = NOW()
             WHERE barcode = $2 AND LOWER(TRIM(plant)) = LOWER(TRIM($3))`,
            [qty, event.barcode, event.plant],
          );
          contributions = [{ plant: event.plant, qty }];
        }
        if (mode === 'void') {
          for (const c of contributions) {
            await client.query(
              `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
               VALUES ($1,$2,$3,$4,0,'adjust',$5,$6,'loading')`,
              [event.barcode, product?.id ?? null, c.plant, c.qty, `Loading slip ${slip.orderNumber} reset — deleted from landing table`, userCode ?? null],
            );
          }
        }
      }
      if (mode === 'void') {
        await client.query(
          `UPDATE loading_scan_events SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2 WHERE id = $3`,
          [userCode ?? null, 'Loading slip reset (deleted from landing table)', event.id],
        );
      }
    }

    let removedEvents = 0;
    let removedLedgerRows = 0;
    if (mode === 'remove') {
      // Every scan entry for the order, already-voided ones included.
      removedEvents = (await client.query(`DELETE FROM loading_scan_events WHERE order_number = $1`, [slip.orderNumber])).rowCount ?? 0;
      await client.query(`DELETE FROM loading_handoffs WHERE order_number = $1`, [slip.orderNumber]);
      // Exact suffix/prefix matches on this order number — never LIKE with the raw number, so
      // order "100" can't take "1001"'s rows.
      const suffix = ` for order ${slip.orderNumber}`;
      removedLedgerRows = (await client.query(
        `DELETE FROM stock_movements
         WHERE source = 'loading' AND (
           RIGHT(reason, LENGTH($1)) = $1
           OR LEFT(reason, LENGTH($2)) = $2
         )`,
        [suffix, `Loading slip ${slip.orderNumber} reset`],
      )).rowCount ?? 0;
    }

    await client.query(
      `UPDATE proforma_slips
       SET vehicle_number = NULL, vehicle_info_id = NULL, vehicle_assigned_by_code = NULL,
           loading_completed_at = NULL, loading_completed_by_code = NULL,
           loading_owner_code = NULL, loading_owner_name = NULL, loading_paused_at = NULL,
           loading_stv = NULL, storekeeper_info = NULL,
           notion_store_keeper_push = false, notion_status = $2, status_before_loading = NULL
       WHERE id = $1`,
      [slip.id, restoredStatus],
    );
    await client.query(`DELETE FROM loading_records WHERE order_number = $1`, [slip.orderNumber]);

    await client.query('COMMIT');

    // Notion follows the app: the status goes back, and StoreKeeper tags the app wrote are cleared
    // (only for loads whose tags the app pushed — hand-typed Notion values on older loads stay).
    void syncOrderToNotion(slip.orderNumber, { status: restoredStatus }, actor(req));
    if (hadNotionStoreKeeper) void pushStoreKeeperInfoToNotion(slip.orderNumber, '');

    // Always logged (even without a user code) and never allowed to fail the request: the delete
    // has already been committed above.
    try {
      await storage.logActivity({
        pageName: 'Loading', action: 'delete', entityType: 'proforma_slip', entityId: slip.id,
        details: mode === 'remove'
          ? `Loading removed completely for order ${slip.orderNumber} by ${userName ?? userCode} — ${events.length} scan(s) reversed, ${removedEvents} scan entr(ies) and ${removedLedgerRows} ledger row(s) deleted, status back to ${restoredStatus}`
          : `Loading reset for order ${slip.orderNumber} by ${userName ?? userCode} — ${events.length} scan(s) voided, vehicle un-assigned, status back to ${restoredStatus}`,
        userCode, userName,
      });
    } catch (activityError) {
      console.error('[Loading] Could not write the delete Activity entry:', activityError instanceof Error ? activityError.message : activityError);
    }

    res.json({ success: true, mode, reversedEvents: events.length, removedEvents, restoredStatus });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error resetting loading slip:', error);
    res.status(500).json({ message: 'Failed to reset loading slip' });
  } finally {
    client.release();
  }
};
router.post('/loading/proforma/:orderNumber/reset', requireLoadingVoidAccess, resetLoadingSlip);
router.post('/loading/master/proforma/:orderNumber/reset', requireLoadMasterWrite, resetLoadingSlip);

// Whether a scan counts as "regular" (fills the item's expected quantity) or "extra" (beyond it)
// is decided once, at scan time, and stored on that row — /scan itself never revisits it. So
// voiding or correcting an EARLIER event never used to update a LATER event's own is_extra flag:
// void a 20-box regular scan and a pre-existing 5-box "extra" scan for the same barcode stayed
// labeled extra forever, even though the void just opened up 20 boxes of room it could slide
// into. This re-walks every surviving (non-voided) event for the order+barcode in original scan
// order and recomputes each one's flag fresh against the item's expected quantity — the exact
// split logic /scan uses, just re-applied to what's left. A single scan that straddled the
// regular/extra boundary was always inserted as two separate rows (see insertEvent below), never
// one row with a mixed qty, so this only ever flips a whole row's flag — it never needs to split
// or merge rows.
async function reclassifyLoadingEvents(client: any, orderNumber: string, barcode: string, expectedQty: number): Promise<void> {
  const { rows } = await client.query(
    `SELECT id, total_qty, is_extra FROM loading_scan_events
      WHERE order_number = $1 AND barcode = $2 AND voided IS NOT TRUE
      ORDER BY scanned_at ASC, id ASC
      FOR UPDATE`,
    [orderNumber, barcode],
  );
  let regularSoFar = 0;
  for (const row of rows) {
    const qty = Number(row.total_qty ?? 0);
    const remainingBefore = Math.max(0, expectedQty - regularSoFar);
    const shouldBeExtra = qty > remainingBefore;
    if (shouldBeExtra !== row.is_extra) {
      await client.query(`UPDATE loading_scan_events SET is_extra = $1 WHERE id = $2`, [shouldBeExtra, row.id]);
    }
    if (!shouldBeExtra) regularSoFar += qty;
  }
}

// POST /api/loading/events/:id/void — the Load Event tab's Void action (Scan History page).
// Marks a single loading_scan_events row as a mistake: stays in history (never deleted), but its
// quantity is reversed back into product_plant_stock — the mirror image of what /scan's decrement
// did, since a loading scan REMOVES stock rather than adding it (unlike order_scan_events' void,
// which subtracts back out — see reverseLiveScanStock in server/lib/orderGroupReport.ts). No
// order_scan_items-style item record to reconcile here (withProgress recomputes "loaded" live by
// summing non-voided rows), so this is simpler than order-scan's void: no FIFO credit transfer,
// no same-part Extra backfill — just reverse the stock and mark the row.
const voidLoadingEvent = async (req: Request, res: Response) => {
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
    if (!canAccessPlant(req, event.plant)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Access denied for this plant' });
    }
    if (event.voided) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This scan is already voided' });
    }

    const qty = Number(event.total_qty ?? 0);
    if (qty > 0 && event.plant && event.barcode) {
      const product = await storage.getProductByBarcode(event.barcode, event.plant);
      // Credit back exactly whichever plant(s) this event's stock was pooled from (see
      // server/lib/statePool.ts) — falls back to the old plant-only credit for an event that
      // predates loading_stock_pulls.
      let contributions = await reverseStockPullsForEvent(client, event.id, event.barcode);
      if (contributions.length === 0) {
        await reconcileProductPlantStockBarcode(client, product?.id, event.plant, event.barcode);
        await client.query(
          `UPDATE product_plant_stock SET in_stock = in_stock + $1, updated_at = NOW()
           WHERE barcode = $2 AND LOWER(TRIM(plant)) = LOWER(TRIM($3))`,
          [qty, event.barcode, event.plant],
        );
        contributions = [{ plant: event.plant, qty }];
      }
      for (const c of contributions) {
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
           VALUES ($1,$2,$3,$4,0,'adjust',$5,$6,'loading')`,
          [event.barcode, product?.id ?? null, c.plant, c.qty, `Voided load scan for order ${event.order_number}`, userCode ?? null],
        );
      }
    }

    const { rows: voidRows } = await client.query(
      `UPDATE loading_scan_events
       SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2
       WHERE id = $3
       RETURNING *`,
      [userCode ?? null, reason, eventId],
    );

    // This void just changed how much of this barcode is "loaded," so any surviving extra scan
    // for the same order+barcode may now belong in the regular slot this freed up.
    const voidedSlip = await storage.getProformaSlipByOrderNumber(event.order_number);
    const voidedItems = voidedSlip ? await storage.getProformaSlipItems(voidedSlip.id) : [];
    const voidedMatchedItem = voidedItems.find((i: any) => normalize(i.barcode) === normalize(event.barcode));
    if (voidedMatchedItem) {
      await reclassifyLoadingEvents(client, event.order_number, event.barcode, voidedMatchedItem.quantity ?? 0);
    }

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
          notionStatus: NOTION_LOADING_STATUS,
        } as any);
        void syncOrderToNotion(slip.orderNumber, { status: NOTION_LOADING_STATUS }, actor(req));
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
};
router.post('/loading/events/:id/void', requireLoadingVoidAccess, voidLoadingEvent);
router.post('/loading/master/events/:id/void', requireLoadMasterWrite, voidLoadingEvent);

// PUT /api/loading/events/:id — body: { totalQty }. Corrects a mistake in an already-recorded
// load scan (Load Event has no STV concept — see Unloading/Order Scan for that). No cached
// progress table here (loaded-so-far is always summed live from loading_scan_events, same as
// Unloading), and no cross-part credit system like Order Scan's — so unlike that one, this is a
// direct in-place-feeling correction: reverse the old qty's stock, void the old event, then
// re-run the same regular/extra split and stock application /scan itself does for the new qty.
// Two audit rows (old voided, new corrected) instead of a silently-edited one, same as everywhere
// else in this app.
router.put('/loading/events/:id', requireLoadingVoidAccess, async (req: Request, res: Response) => {
  const eventId = parseInt(req.params.id);
  if (isNaN(eventId)) return res.status(400).json({ message: 'Invalid event ID' });

  const newQty = Math.round(Number(req.body?.totalQty));
  if (!Number.isFinite(newQty) || newQty <= 0) return res.status(400).json({ message: 'totalQty must be a positive number' });

  const { userCode, userName } = actor(req);
  const editorLabel = userName ?? userCode ?? 'unknown';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: eventRows } = await client.query(`SELECT * FROM loading_scan_events WHERE id = $1 FOR UPDATE`, [eventId]);
    const event = eventRows[0];
    if (!event) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Load event not found' }); }
    if (event.voided) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'This scan is voided — nothing to edit' }); }

    const oldQty = Number(event.total_qty ?? 0);
    if (newQty === oldQty) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'That is already the current quantity' }); }

    const slip = await storage.getProformaSlipByOrderNumber(event.order_number);
    if (!slip) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Proforma slip not found' }); }

    // Reverse the old qty's stock (Loading REMOVES stock, so reversing adds it back — same
    // direction the void handler above uses) before checking whether the new qty actually fits.
    // Credits back exactly whichever plant(s) it was pooled from (server/lib/statePool.ts),
    // falling back to the old plant-only credit for an event that predates loading_stock_pulls.
    const product = await storage.getProductByBarcode(event.barcode, event.plant);
    const reversedContributions = await reverseStockPullsForEvent(client, event.id, event.barcode);
    if (reversedContributions.length === 0) {
      await reconcileProductPlantStockBarcode(client, product?.id, event.plant, event.barcode);
      await client.query(
        `UPDATE product_plant_stock SET in_stock = in_stock + $1, updated_at = NOW()
         WHERE barcode = $2 AND LOWER(TRIM(plant)) = LOWER(TRIM($3))`,
        [oldQty, event.barcode, event.plant],
      );
    }

    let newQtyContributions: StockPullContribution[];
    try {
      // Re-debits from the state pool (own plant first, then other same-state plants) — the
      // old qty was just credited back into that same pool above, so this is a clean re-check
      // against current, post-credit numbers.
      newQtyContributions = await debitStatePool(client, event.barcode, event.plant, newQty, product?.id);
    } catch (err: any) {
      await client.query('ROLLBACK');
      return res.status(err?.status ?? 409).json({ message: err?.message ?? `Cannot correct to ${newQty}.` });
    }

    await client.query(
      `UPDATE loading_scan_events SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2 WHERE id = $3`,
      [userCode ?? null, `Qty corrected: ${oldQty} -> ${newQty} (edited by ${editorLabel})`, eventId],
    );

    // Same regular/extra split /scan itself computes, against expected qty minus whatever's
    // still loaded (now excluding the just-voided old event).
    const rawItems = await storage.getProformaSlipItems(slip.id);
    const matchedItem = rawItems.find((i) => normalize(i.barcode) === normalize(event.barcode));
    const { rows: loadedRows } = await client.query(
      `SELECT COALESCE(SUM(total_qty), 0)::int AS "loaded" FROM loading_scan_events
       WHERE order_number = $1 AND barcode = $2 AND voided IS NOT TRUE`,
      [slip.orderNumber, event.barcode],
    );
    const alreadyLoaded = loadedRows[0]?.loaded ?? 0;
    const expected = matchedItem?.quantity ?? 0;
    const remainingBefore = matchedItem ? Math.max(0, expected - alreadyLoaded) : 0;
    const regularQty = matchedItem ? Math.min(newQty, remainingBefore) : 0;
    const extraQty = newQty - regularQty;

    const state = await getPlantStateCode(client, event.plant ?? '');
    const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, expected);
    const insertEvent = async (totalQty: number, isExtra: boolean): Promise<number> => {
      const { rows: insertedRows } = await client.query(
        // Keeps the ORIGINAL scan's time — this row stands in for that scan — and records when
        // the correction was made in adjusted_at, so the history shows both.
        `INSERT INTO loading_scan_events
           (order_number, proforma_slip_id, barcode, item_name, sap_code, pallets, loose_qty, total_qty, is_extra, plant, scanned_by_code, scanned_by_name, scanned_at, adjusted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamp, NOW()),NOW()) RETURNING id`,
        [
          slip.orderNumber, slip.id, event.barcode, event.item_name, event.sap_code,
          itemsPerPallet > 0 ? Math.floor(totalQty / itemsPerPallet) : 0,
          itemsPerPallet > 0 ? totalQty % itemsPerPallet : totalQty,
          totalQty, isExtra, event.plant, event.scanned_by_code, event.scanned_by_name,
          event.scanned_at,
        ],
      );
      return insertedRows[0].id as number;
    };
    // Same regular/extra bookkeeping split of a single debit as /scan (see its own comment) —
    // slice newQtyContributions across whichever event(s) get inserted so each one's own
    // loading_stock_pulls rows sum to exactly its own total_qty.
    let sliceRemaining = regularQty;
    const regularContributions: StockPullContribution[] = [];
    const extraContributions: StockPullContribution[] = [];
    for (const c of newQtyContributions) {
      if (sliceRemaining <= 0) { extraContributions.push(c); continue; }
      if (c.qty <= sliceRemaining) { regularContributions.push(c); sliceRemaining -= c.qty; }
      else {
        regularContributions.push({ plant: c.plant, qty: sliceRemaining });
        extraContributions.push({ plant: c.plant, qty: c.qty - sliceRemaining });
        sliceRemaining = 0;
      }
    }
    if (regularQty > 0) {
      const id = await insertEvent(regularQty, false);
      await recordStockPulls(client, id, regularContributions);
    }
    if (extraQty > 0) {
      const id = await insertEvent(extraQty, true);
      await recordStockPulls(client, id, extraContributions);
    }

    const extraQtyByPlant = new Map<string, number>();
    for (const c of extraContributions) extraQtyByPlant.set(c.plant, (extraQtyByPlant.get(c.plant) ?? 0) + c.qty);
    for (const c of newQtyContributions) {
      await client.query(
        `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
         VALUES ($1,$2,$3,$4,$5,'adjust',$6,$7,'loading')`,
        [event.barcode, product?.id ?? null, c.plant, -c.qty, extraQtyByPlant.get(c.plant) ?? 0, `Qty corrected (edited by ${editorLabel})`, userCode ?? null],
      );
    }

    // This correction just changed how much of this barcode is "loaded" — re-check every
    // surviving event for the same order+barcode, not just the two rows just inserted, in case a
    // separate pre-existing extra scan should now slide into the room this correction opened up.
    if (matchedItem) {
      await reclassifyLoadingEvents(client, slip.orderNumber, event.barcode, expected);
    }

    await client.query('COMMIT');

    // Same completion-flip-in-either-direction reasoning as the void handler above, just checked
    // both ways since an edit can push an order past complete OR pull it back short of complete.
    const { allComplete } = await withProgress(slip, rawItems);
    if (allComplete && !(slip as any).loadingCompletedAt) {
      await storage.updateProformaSlip(slip.id, { loadingCompletedAt: new Date(), loadingCompletedByCode: userCode ?? null } as any);
    } else if (!allComplete && (slip as any).loadingCompletedAt) {
      await storage.updateProformaSlip(slip.id, { loadingCompletedAt: null, loadingCompletedByCode: null } as any);
    }

    res.json({ success: true, regularQty, extraQty });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error editing load event:', error);
    res.status(500).json({ message: 'Failed to edit load event' });
  } finally {
    client.release();
  }
});

export default router;
