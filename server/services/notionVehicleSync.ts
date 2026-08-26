import { Client } from '@notionhq/client';
import { storage } from '../storage';
import { pool } from '../db';
import { extractText, extractFloat, firstOf } from '../lib/notionProperties';
import type { VehicleInfo } from '@shared/schema';

const notion = new Client({
  auth: (process.env.NOTION_INTEGRATION_SECRET ?? process.env.NOTION_API_KEY ?? '').trim(),
});

export const NOTION_VEHICLE_DATABASE_ID = (process.env.NOTION_VEHICLE_DATABASE_ID ?? '').trim() || undefined;

let isSyncing = false;

// Human labels for the diff report — same role as notionInventorySync.ts's FIELD_LABELS.
export const VEHICLE_FIELD_LABELS: Record<string, string> = {
  srNo: 'Sr. No.', vehicleNumber: 'Vehicle No', rtoNumber: 'RTO Number', series: 'Series',
  companyType: 'Company Type', acTruckUrl: 'AC Track (URL)', company: 'Company',
  manufacturer: 'Manufacturer', modelYear: 'Model Year',
  engine: 'Engine', volume: 'Volume', vehiclePercent: 'Vehicle %',
  gps: 'GPS', forGps: 'For GPS', driver: 'Driver', recordDriver: 'Driver Records',
  plant: 'Plant', status: 'Status', remark: 'Remark', vehicleFitness: 'Vehicle File Management',
  latestEntry: 'Latest Entry', latestOrder: 'Latest Order', linkToVehicle: 'Link to Vehicle No.',
  orderCurrent: 'Order {Current}', orderBackup: 'Order {Backup}',
};

export interface VehicleFieldChange {
  field: string;
  label: string;
  oldValue: string | number | boolean | null | undefined;
  newValue: string | number | boolean | null | undefined;
}

export interface VehicleChange {
  vehicleId: number;
  vehicleNumber: string;
  changes: VehicleFieldChange[];
}

export interface CreatedVehicle {
  vehicleNumber: string;
  notionPageId: string;
}

// A vehicle number that collides between two things that can't be auto-resolved — either two
// different Notion pages both claim it, or an already-linked local vehicle (different Notion
// page) collides with a new one. Needs a human to fix the data in Notion. Distinct from
// `errors` (which are real failures) so the UI can show this as "needs your attention" rather
// than "something broke".
export interface VehicleConflict {
  vehicleNumber: string;
  notionPageId: string;
  notionPageUrl: string;
  reason: string;
}

export interface VehicleSyncReport {
  syncTime: Date;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  notFound: number;
  triggeredBy: string;
  appliedBy?: string;
  changedVehicles: VehicleChange[];
  createdVehicles: CreatedVehicle[];
  conflicts: VehicleConflict[];
  errors: string[];
}

function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

const syncHistory: VehicleSyncReport[] = [];
const MAX_HISTORY = 10;

let pendingReport: VehicleSyncReport | null = null;
const pendingUpdates = new Map<number, Record<string, any>>();
const pendingCreates: Record<string, any>[] = [];
// The most recent run's conflicts, kept around independent of pendingReport (which clears once
// Apply runs) so the "needs attention" badge on the page stays accurate even after changes have
// been applied — a conflict isn't resolved just because the rest of the batch was.
let lastConflicts: VehicleConflict[] = [];
export function getLastConflicts(): VehicleConflict[] { return lastConflicts; }

// DB-persisted (notion_vehicle_sync_config, created in server/index.ts), not an in-memory
// flag — same reasoning as notion_inventory_sync_config: off by default so a fresh install
// never silently writes to vehicle_info unattended, and the setting survives a server restart.
export async function getAutoApplyEnabled(): Promise<boolean> {
  const { rows } = await pool.query(`SELECT auto_apply_enabled AS "autoApplyEnabled" FROM notion_vehicle_sync_config WHERE id = 1`);
  return rows[0]?.autoApplyEnabled === true;
}

export async function setAutoApplyEnabled(enabled: boolean, updatedBy: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO notion_vehicle_sync_config (id, auto_apply_enabled, updated_by, updated_at)
     VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET auto_apply_enabled = EXCLUDED.auto_apply_enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [enabled, updatedBy],
  );
}

export function getPendingReport(): VehicleSyncReport | null { return pendingReport; }
export function getSyncHistory(): VehicleSyncReport[] { return syncHistory; }
export function getSyncStatus() { return { isSyncing, hasPending: !!pendingReport, conflictCount: lastConflicts.length }; }

// ─── Map Notion page → vehicle fields ────────────────────────────────────────
// Property names confirmed against the real Notion database (schema-inspection run,
// 2026-08-25). Several read the RAW underlying field rather than a formula that just
// reformats it (e.g. "Link to RTO No. :" instead of the "RTO Number :" formula that wraps it
// in braces) — see the field comments on the vehicleInfo table in shared/schema.ts for why.
// The three relation properties with no title rollup (VEHICLE FILE MANAGEMENT,
// ORDER{CURRENT}, ORDER {BKUP}...) are intentionally not read here — nothing to show as text.
function mapNotionPageToVehicleFields(page: any) {
  const p = page.properties;
  return {
    notionPageId:    page.id as string,
    vehicleNumber:   firstOf(p, 'Vehicle No. :'),
    // "Link to Sr. No:" is a formula giving Sr. No. as a clean number — preferred over parsing
    // the raw "Sr. No. :" rich_text field by hand.
    srNo:            extractFloat(p['Link to Sr. No:']) ?? extractFloat(p['Sr. No. :']),
    rtoNumber:       firstOf(p, 'Link to RTO No. :'),
    series:          firstOf(p, 'Series :'),
    companyType:     firstOf(p, 'Company Type :'),
    acTruckUrl:      extractText(p['AC Track :']),
    company:         firstOf(p, 'Company :'),
    manufacturer:    firstOf(p, 'Manufacturer :'),
    modelYear:       firstOf(p, 'Model Year :'),
    engine:          firstOf(p, 'Engine :'),
    volume:          extractFloat(p['Vol ']),
    vehiclePercent:  extractFloat(p['Vehi %']),
    gps:             firstOf(p, 'GPS :'),
    forGps:          firstOf(p, 'For GPS'),
    driver:          firstOf(p, 'Driver :'),
    recordDriver:    firstOf(p, 'Dri Records :'),
    plant:           firstOf(p, 'Plant :'),
    status:          firstOf(p, 'Status :'),
    remark:          firstOf(p, 'REMARK'),
    latestEntry:     firstOf(p, 'Latest Entry :'),
    latestOrder:     firstOf(p, 'Latest Order :'),
    linkToVehicle:   firstOf(p, 'Link to Vehicle No. :'),
  };
}

function buildVehicleData(fields: ReturnType<typeof mapNotionPageToVehicleFields>): Record<string, any> {
  const data: Record<string, any> = {
    vehicleNumber: fields.vehicleNumber || '',
    notionPageId: fields.notionPageId,
    srNo: fields.srNo ? Math.round(fields.srNo) : 0,
  };
  const optional = [
    'rtoNumber', 'series', 'companyType', 'acTruckUrl', 'company', 'manufacturer', 'modelYear', 'engine',
    'volume', 'vehiclePercent', 'gps', 'forGps', 'driver', 'recordDriver', 'plant', 'status',
    'remark', 'latestEntry', 'latestOrder', 'linkToVehicle',
  ];
  for (const key of optional) {
    const val = (fields as any)[key];
    if (val !== undefined && val !== null && val !== '') data[key] = val;
  }
  return data;
}

// This database has ~30 properties total but mapNotionPageToVehicleFields only reads these 22
// — the rest (Last edited by, Created time, VEHICLE FILE MANAGEMENT, ORDER{CURRENT}, ORDER
// {BKUP}..., RTO Number :, Volume, Vehicle %, for driver, Company Type :'s own duplicates, etc.)
// are unused rollups/formulas/relations. Notion computes EVERY property on EVERY row in a
// query unless told to filter — that's what made a page_size of 100 blow past Notion's own
// response-time budget in the first place ('service_unavailable': "reduce page_size or use
// filter_properties... retry with exponential backoff"). filter_properties (below, resolved to
// property ids via one database.retrieve() call) tells Notion to skip computing anything else,
// which is the actual fix for the slowness — page_size and retry are just a safety net on top.
const USED_PROPERTY_NAMES = [
  'Vehicle No. :', 'Link to Sr. No:', 'Sr. No. :', 'Link to RTO No. :', 'Series :',
  'Company Type :', 'AC Track :', 'Company :', 'Manufacturer :', 'Model Year :', 'Engine :',
  'Vol ', 'Vehi %', 'GPS :', 'For GPS', 'Driver :', 'Dri Records :', 'Plant :', 'Status :',
  'REMARK', 'Latest Entry :', 'Latest Order :', 'Link to Vehicle No. :',
];

let cachedFilterPropertyIds: string[] | null = null;
async function getFilterPropertyIds(): Promise<string[]> {
  if (cachedFilterPropertyIds) return cachedFilterPropertyIds;
  const database: any = await notion.databases.retrieve({ database_id: NOTION_VEHICLE_DATABASE_ID! });
  const ids: string[] = [];
  for (const name of USED_PROPERTY_NAMES) {
    const id = database.properties?.[name]?.id;
    if (id) ids.push(id);
    else console.warn(`[Notion Vehicle Sync] Property "${name}" not found on the database — check it wasn't renamed`);
  }
  cachedFilterPropertyIds = ids;
  return ids;
}

async function queryWithRetry(params: any, attempt = 1): Promise<any> {
  try {
    return await notion.databases.query(params);
  } catch (err: any) {
    const retryable = err?.code === 'service_unavailable' || err?.status === 503 || err?.code === 'rate_limited';
    if (retryable && attempt < 5) {
      const delayMs = 1000 * 2 ** attempt; // 2s, 4s, 8s, 16s
      console.warn(`[Notion Vehicle Sync] ${err.code ?? err.status} on query — retrying in ${delayMs}ms (attempt ${attempt}/4)`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return queryWithRetry(params, attempt + 1);
    }
    throw err;
  }
}

async function fetchAllVehiclePages(): Promise<any[]> {
  if (!NOTION_VEHICLE_DATABASE_ID) throw new Error('NOTION_VEHICLE_DATABASE_ID is not set');
  const filterPropertyIds = await getFilterPropertyIds();
  const pages: any[] = [];
  let cursor: string | undefined;
  do {
    const response: any = await queryWithRetry({
      database_id: NOTION_VEHICLE_DATABASE_ID,
      page_size: 50,
      filter_properties: filterPropertyIds,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    console.log(`[Notion Vehicle Sync] Fetched ${pages.length} page(s) so far...`);
  } while (cursor);
  return pages;
}

function diffFields(notionData: Record<string, any>, vehicle: VehicleInfo, comparable: (v: unknown) => string) {
  const updates: Record<string, any> = {};
  const fieldChanges: VehicleFieldChange[] = [];
  for (const key of Object.keys(notionData)) {
    if (key === 'notionPageId') continue;
    const notionVal = notionData[key];
    const localVal = (vehicle as any)[key];
    if (comparable(notionVal) !== comparable(localVal)) {
      updates[key] = notionVal;
      fieldChanges.push({ field: key, label: VEHICLE_FIELD_LABELS[key] ?? key, oldValue: localVal ?? null, newValue: notionVal });
    }
  }
  return { updates, fieldChanges };
}

function computeChanges(notionPages: any[], allVehicles: VehicleInfo[]) {
  const byNotionPageId = new Map(allVehicles.filter((v) => v.notionPageId).map((v) => [v.notionPageId!, v]));
  // Keyed by vehicle number (trimmed/lowercased) so a Notion page not yet linked by id can
  // still be matched to an existing local row that has the same number. vehicle_number is
  // unique in the DB, so this map is naturally 1:1 — no local duplicates possible already.
  const byVehicleNumber = new Map(allVehicles.map((v) => [v.vehicleNumber.trim().toLowerCase(), v]));
  // Tracks vehicle numbers claimed so far *within this same Notion batch* — catches two
  // brand-new Notion pages (neither linked to any local row yet) colliding with each other.
  const seenInBatch = new Map<string, string>(); // key -> notionPageId that claimed it

  const changedVehicles: VehicleChange[] = [];
  const toCreate: Record<string, any>[] = [];
  const createdVehicles: CreatedVehicle[] = [];
  const updatesMap = new Map<number, Record<string, any>>();
  const conflicts: VehicleConflict[] = [];
  const errors: string[] = [];
  let skipped = 0;
  let notFound = 0;

  const comparable = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    return String(value).trim().replace(/\s+/g, ' ');
  };

  for (const page of notionPages) {
    try {
      const fields = mapNotionPageToVehicleFields(page);
      if (!fields.vehicleNumber) { notFound++; continue; }
      const key = fields.vehicleNumber.trim().toLowerCase();

      const linkedVehicle = byNotionPageId.get(fields.notionPageId);
      const notionData = buildVehicleData(fields);

      if (linkedVehicle) {
        // Already linked to this exact Notion page — an ordinary update check.
        const { updates, fieldChanges } = diffFields(notionData, linkedVehicle, comparable);
        if (fieldChanges.length > 0) {
          updatesMap.set(linkedVehicle.id, updates);
          changedVehicles.push({ vehicleId: linkedVehicle.id, vehicleNumber: linkedVehicle.vehicleNumber, changes: fieldChanges });
        } else {
          skipped++;
        }
        continue;
      }

      const sameNumberVehicle = byVehicleNumber.get(key);

      if (sameNumberVehicle) {
        if (!sameNumberVehicle.notionPageId) {
          // Situation 1 — same real vehicle, just never linked to Notion before. Adopt this
          // Notion page as its source: link it and pull in whatever else differs, instead of
          // discarding the Notion row as a "duplicate".
          const { updates, fieldChanges } = diffFields(notionData, sameNumberVehicle, comparable);
          updates.notionPageId = fields.notionPageId;
          fieldChanges.unshift({ field: 'notionPageId', label: 'Linked to Notion', oldValue: 'Not linked', newValue: 'Linked' });
          updatesMap.set(sameNumberVehicle.id, updates);
          changedVehicles.push({ vehicleId: sameNumberVehicle.id, vehicleNumber: sameNumberVehicle.vehicleNumber, changes: fieldChanges });
        } else {
          // Situation 2 — this local vehicle is already linked to a DIFFERENT Notion page.
          // Can't tell which one is right — needs a human to fix it in Notion.
          conflicts.push({
            vehicleNumber: fields.vehicleNumber, notionPageId: fields.notionPageId, notionPageUrl: notionPageUrl(fields.notionPageId),
            reason: `Another vehicle already exists with this number, linked to a different Notion page.`,
          });
        }
        continue;
      }

      const seenAsId = seenInBatch.get(key);
      if (seenAsId) {
        // Situation 2b — two (or more) brand-new Notion pages in this same sync both use this
        // number (e.g. a blank/half-filled title like "S"). The first one is created normally;
        // every later page with the same number is flagged here instead of also being created
        // (which would just hit the unique constraint again) or silently dropped.
        conflicts.push({
          vehicleNumber: fields.vehicleNumber, notionPageId: fields.notionPageId, notionPageUrl: notionPageUrl(fields.notionPageId),
          reason: `Another Notion page in this same sync also uses this vehicle number — check for a blank/duplicate title in Notion.`,
        });
        continue;
      }

      seenInBatch.set(key, fields.notionPageId);
      toCreate.push(notionData);
      createdVehicles.push({ vehicleNumber: fields.vehicleNumber, notionPageId: fields.notionPageId });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      console.error('[Notion Vehicle Sync] Error processing page:', err);
    }
  }

  return { changedVehicles, toCreate, createdVehicles, updatesMap, conflicts, errors, skipped, notFound };
}

// ─── Detect-only (dry-run): stores pending, no DB writes ─────────────────────

export async function detectVehicleChangesFromNotion(triggeredBy = 'system'): Promise<VehicleSyncReport> {
  if (!NOTION_VEHICLE_DATABASE_ID) throw new Error('NOTION_VEHICLE_DATABASE_ID is not set');
  if (isSyncing) throw new Error('A sync is already in progress — please wait');

  isSyncing = true;
  try {
    console.log('[Notion Vehicle Sync] Detecting changes (dry-run)...');
    const notionPages = await fetchAllVehiclePages();
    const allVehicles = await storage.getAllVehicleInfo();
    const { changedVehicles, toCreate, createdVehicles, updatesMap, conflicts, errors, skipped, notFound } =
      computeChanges(notionPages, allVehicles);

    const report: VehicleSyncReport = {
      syncTime: new Date(), total: notionPages.length,
      created: toCreate.length, updated: changedVehicles.length,
      skipped, notFound, triggeredBy, changedVehicles, createdVehicles, conflicts, errors,
    };

    pendingReport = report;
    pendingUpdates.clear();
    pendingCreates.length = 0;
    for (const [id, upd] of updatesMap.entries()) pendingUpdates.set(id, upd);
    pendingCreates.push(...toCreate);
    lastConflicts = conflicts;

    console.log(`[Notion Vehicle Sync] Detected — new: ${toCreate.length}, changed: ${changedVehicles.length}, unchanged: ${skipped}, needs attention: ${conflicts.length}`);
    return report;
  } finally {
    isSyncing = false;
  }
}

// ─── Apply pending (detected) changes ────────────────────────────────────────
// appliedByCode: the userCode of whoever clicked Apply — stamped as lastEditedByCode on every
// row this run touches (create or update), so the page can show a real name, not a blank.
export async function applyPendingVehicleChanges(appliedByCode: string | null): Promise<VehicleSyncReport> {
  if (!pendingReport) throw new Error('No pending changes. Run detection first.');
  if (isSyncing) throw new Error('A sync is already in progress — please wait');

  isSyncing = true;
  try {
    const errors: string[] = [...pendingReport.errors];
    let updated = 0;
    let created = 0;
    const now = new Date();

    for (const [vehicleId, updates] of pendingUpdates.entries()) {
      try {
        await storage.updateVehicleInfo(vehicleId, {
          ...updates,
          ...(appliedByCode ? { lastEditedByCode: appliedByCode } : {}),
        } as any);
        updated++;
      } catch (err) {
        errors.push(`Update vehicle ${vehicleId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (let i = 0; i < pendingCreates.length; i++) {
      const data = pendingCreates[i];
      try {
        await storage.createVehicleInfo({
          ...data,
          ...(appliedByCode ? { createdByCode: appliedByCode, lastEditedByCode: appliedByCode } : {}),
        } as any);
        created++;
      } catch (createErr) {
        const label = data?.vehicleNumber || `row ${i + 1}`;
        errors.push(`Create "${label}": ${createErr instanceof Error ? createErr.message : String(createErr)}`);
      }
    }

    const report: VehicleSyncReport = { ...pendingReport, updated, created, errors, appliedBy: appliedByCode ?? undefined };
    syncHistory.unshift(report);
    if (syncHistory.length > MAX_HISTORY) syncHistory.splice(MAX_HISTORY);
    pendingReport = null;
    pendingUpdates.clear();
    pendingCreates.length = 0;

    console.log(`[Notion Vehicle Sync] Applied — updated: ${updated}, created: ${created}, by: ${appliedByCode ?? 'system'}`);
    return report;
  } finally {
    isSyncing = false;
  }
}

// ─── Full sync: clear vehicle_info → import everything from Notion ──────────

export async function fullSyncVehiclesFromNotion(triggeredBy: string, triggeredByCode: string | null): Promise<VehicleSyncReport> {
  if (!NOTION_VEHICLE_DATABASE_ID) throw new Error('NOTION_VEHICLE_DATABASE_ID is not set');
  if (isSyncing) throw new Error('A sync is already in progress — please wait');

  isSyncing = true;
  const errors: string[] = [];
  let created = 0;
  const createdVehicles: CreatedVehicle[] = [];

  try {
    console.log('[Notion Vehicle Sync] Full sync — clearing vehicle_info...');
    const notionPages = await fetchAllVehiclePages();
    console.log(`[Notion Vehicle Sync] Fetched ${notionPages.length} pages from Notion`);

    await storage.clearVehicleInfo();
    console.log('[Notion Vehicle Sync] vehicle_info cleared');

    // Same duplicate-title guard as computeChanges (see its comment) — the table is empty at
    // this point, so "Situation 1" (adopt an existing unlinked local vehicle) can't happen here;
    // this only catches two-or-more Notion pages colliding with EACH OTHER within this run
    // (e.g. several blank/placeholder rows all titled "S"), tracked as conflicts needing a
    // human to fix in Notion, not silently dropped.
    const seenVehicleNumbers = new Map<string, string>(); // key -> notionPageId that claimed it
    const conflicts: VehicleConflict[] = [];
    for (const page of notionPages) {
      try {
        const fields = mapNotionPageToVehicleFields(page);
        if (!fields.vehicleNumber) continue;
        const key = fields.vehicleNumber.trim().toLowerCase();
        if (seenVehicleNumbers.has(key)) {
          conflicts.push({
            vehicleNumber: fields.vehicleNumber, notionPageId: fields.notionPageId, notionPageUrl: notionPageUrl(fields.notionPageId),
            reason: `Another Notion page in this same sync also uses this vehicle number — check for a blank/duplicate title in Notion.`,
          });
          continue;
        }
        seenVehicleNumbers.set(key, fields.notionPageId);
        const data = buildVehicleData(fields);
        await storage.createVehicleInfo({
          ...data,
          ...(triggeredByCode ? { createdByCode: triggeredByCode, lastEditedByCode: triggeredByCode } : {}),
        } as any);
        created++;
        createdVehicles.push({ vehicleNumber: fields.vehicleNumber, notionPageId: fields.notionPageId });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    const report: VehicleSyncReport = {
      syncTime: new Date(), total: notionPages.length, created, updated: 0,
      skipped: 0, notFound: notionPages.length - created - errors.length - conflicts.length,
      triggeredBy, appliedBy: triggeredByCode ?? undefined,
      changedVehicles: [], createdVehicles, conflicts, errors,
    };
    syncHistory.unshift(report);
    if (syncHistory.length > MAX_HISTORY) syncHistory.splice(MAX_HISTORY);
    pendingReport = null;
    pendingUpdates.clear();
    pendingCreates.length = 0;
    lastConflicts = conflicts;

    console.log(`[Notion Vehicle Sync] Full sync complete — created: ${created}, needs attention: ${conflicts.length}`);
    return report;
  } finally {
    isSyncing = false;
  }
}
