
import { Client as NotionClient } from '@notionhq/client';
import { pool } from '../db';

// The full column set the manual upload dialog offers — used as the default when no prior
// manual selection has been saved yet.
export const DEFAULT_SCAN_HISTORY_COLUMNS = [
  'Scanned By', 'Code', 'Item', 'Barcode', 'Order', 'Plant', 'Qty', 'Pallets', 'STV', 'Type', 'Time',
];

export type ScanHistoryPushOptions = {
  // Notion DB id or URL; falls back to SCAN_HISTORY_NOTION_DB_ID when omitted.
  pageId?: string | null;
  columns?: string[] | null;
  // null = every plant (system job / admin). [] = none (restricted user with no plants).
  allowedPlants?: string[] | null;
  date?: string; search?: string; scanner?: string; type?: string; plant?: string;
  limit?: number;
};

export type ScanHistoryPushResult = {
  fetched: number; uploaded: number; errors: string[]; databaseId: string; url: string;
};

// Guards against overlapping runs (a slow Notion push still going when the next 30-min tick
// fires, or a manual upload racing the auto job) — the fetch marks each row notion_synced_at
// only AFTER its page is created, so two concurrent runs could double-create a row otherwise.
let syncInProgress = false;
export function isScanHistorySyncInProgress() { return syncInProgress; }

// Core scan-history → Notion push. Extracted from POST /reports/upload-to-notion so the manual
// endpoint and the 30-min auto-sync run identical logic. Only pushes rows with
// notion_synced_at IS NULL and stamps each one as it succeeds, so it's fully idempotent.
export async function pushScanHistoryToNotion(opts: ScanHistoryPushOptions): Promise<ScanHistoryPushResult> {
  const secret = (process.env.NOTION_INTEGRATION_SECRET ?? '').trim();
  if (!secret) throw new Error('NOTION_INTEGRATION_SECRET is not configured');

  const resolvedPageId = (opts.pageId && opts.pageId.trim()) || process.env.SCAN_HISTORY_NOTION_DB_ID || '';
  if (!resolvedPageId) throw new Error('No Notion database ID configured. Set SCAN_HISTORY_NOTION_DB_ID or save one via a manual upload.');

  const columns = (opts.columns && opts.columns.length > 0) ? opts.columns : DEFAULT_SCAN_HISTORY_COLUMNS;

  // Accept a bare 32-char id, a Notion URL (id is 32 contiguous hex there), OR a dashed UUID
  // (what we persist as result.databaseId) — the dashed form has no 32-contiguous run, so fall
  // back to matching after stripping dashes.
  const hexMatch = resolvedPageId.match(/([a-f0-9]{32})/i)
    ?? resolvedPageId.replace(/-/g, '').match(/([a-f0-9]{32})/i);
  if (!hexMatch) throw new Error('Could not find a valid Notion ID. Provide the 32-character ID from the page URL.');
  const raw = hexMatch[1];
  const databaseId = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  const url = `https://www.notion.so/${databaseId.replace(/-/g, '')}`;

  const notion = new NotionClient({ auth: secret });

  // --- Step 1: retrieve database schema ---
  const existingDb = await notion.databases.retrieve({ database_id: databaseId }) as any;
  const schema: Record<string, string> = {};
  for (const [name, prop] of Object.entries(existingDb.properties ?? {})) {
    schema[name] = (prop as any).type;
  }
  const titlePropName = Object.entries(schema).find(([, t]) => t === 'title')?.[0] ?? 'Name';
  const selectedSet = new Set(columns);

  // --- Step 2: add any selected columns the DB doesn't have yet ---
  const propsToAdd: Record<string, any> = {};
  for (const col of Array.from(selectedSet)) {
    if (col in schema) continue;
    if (col === '#') continue;
    if (['Qty', 'Pallets'].includes(col))     propsToAdd[col] = { number: {} };
    else if (['Plant', 'Type'].includes(col)) propsToAdd[col] = { select: {} };
    // 'Time' must be a real date property so Notion shows the actual scan timestamp
    // (order_scan_events.scanned_at) — not the page's built-in Created time (the sync moment).
    else if (col === 'Time')                  propsToAdd[col] = { date: {} };
    else                                      propsToAdd[col] = { rich_text: {} };
  }
  if (Object.keys(propsToAdd).length > 0) {
    await notion.databases.update({ database_id: databaseId, properties: propsToAdd });
    for (const [col, def] of Object.entries(propsToAdd)) schema[col] = Object.keys(def)[0];
  }

  function toNotionValue(propType: string, value: any): any {
    const str = String(value ?? '');
    switch (propType) {
      case 'title':     return { title:     [{ text: { content: str } }] };
      case 'rich_text': return { rich_text: [{ text: { content: str } }] };
      case 'number':    return { number: isNaN(parseFloat(str)) ? 0 : parseFloat(str) };
      case 'select':    return str ? { select: { name: str } } : { select: null };
      case 'date': {
        try { const d = new Date(value); if (!isNaN(d.getTime())) return { date: { start: d.toISOString() } }; } catch {}
        return { date: null };
      }
      case 'checkbox':  return { checkbox: Boolean(value) };
      default:          return { rich_text: [{ text: { content: str } }] };
    }
  }

  // --- Step 3: fetch not-yet-synced scan history rows (with the same plant scoping the manual
  // endpoint used) ---
  const conditions: string[] = [];
  const params: (string | boolean | string[])[] = [];

  if (opts.allowedPlants !== null && opts.allowedPlants !== undefined) {
    if (opts.allowedPlants.length === 0) {
      return { fetched: 0, uploaded: 0, errors: [], databaseId, url };
    }
    params.push(opts.allowedPlants);
    conditions.push(`LOWER(ois.plant) = ANY($${params.length}::text[])`);
  }
  if (opts.plant)   { params.push(opts.plant.toLowerCase()); conditions.push(`LOWER(ois.plant) = $${params.length}`); }
  if (opts.date)    { params.push(opts.date);    conditions.push(`DATE(ose.scanned_at) = $${params.length}`); }
  if (opts.scanner) { params.push(opts.scanner); conditions.push(`ose.scanned_by_name = $${params.length}`); }
  if (opts.type === 'regular') conditions.push(`ose.is_extra = false`);
  if (opts.type === 'extra')   conditions.push(`ose.is_extra = true`);
  if (opts.search) {
    params.push(`%${opts.search.toLowerCase()}%`);
    const n = params.length;
    conditions.push(`(LOWER(COALESCE(ose.item_name,'')) LIKE $${n} OR LOWER(COALESCE(ose.barcode,'')) LIKE $${n} OR LOWER(COALESCE(ose.scanned_by_name,'')) LIKE $${n})`);
  }
  // Never push voided scans, and only rows not already synced.
  conditions.push('ose.voided IS NOT TRUE');
  conditions.push('ose.notion_synced_at IS NULL');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const dataRes = await pool.query(
    `SELECT
       ose.id,
       ose.barcode,
       ose.item_name        AS "itemName",
       ose.pallets,
       ose.total_qty        AS "totalQty",
       ose.is_extra         AS "isExtra",
       ose.stv,
       ose.scanned_by_code  AS "scannedByCode",
       ose.scanned_by_name  AS "scannedByName",
       ose.scanned_at       AS "scannedAt",
       ois.csv_file_name    AS "orderName",
       ois.plant
     FROM order_scan_events ose
     JOIN order_import_sessions ois ON ois.id = ose.session_id
     ${where}
     ORDER BY ose.scanned_at ASC
     LIMIT ${Math.max(1, Math.min(2000, opts.limit ?? 2000))}`,
    params,
  );
  const rows = dataRes.rows;

  // --- Step 4: create a Notion page per row, stamping notion_synced_at on success ---
  let uploaded = 0;
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const h = rows[i];
    try {
      const rowNum = String(i + 1);
      const colValues: Record<string, any> = {
        '#':          rowNum,
        'Scanned By': h.scannedByName ?? '',
        'Code':       h.scannedByCode ?? '',
        'Item':       h.itemName ?? '',
        'Barcode':    h.barcode ?? '',
        'Order':      h.orderName ?? '',
        'Plant':      h.plant || 'Unknown',
        'Qty':        h.totalQty ?? 0,
        'Pallets':    h.pallets != null ? parseFloat(String(h.pallets)) : 0,
        'STV':        h.stv ?? '',
        'Type':       h.isExtra ? 'Extra' : 'Regular',
        'Time':       h.scannedAt ?? null,
      };
      const props: Record<string, any> = {
        [titlePropName]: toNotionValue('title', colValues[titlePropName] ?? rowNum),
      };
      for (const col of Array.from(selectedSet)) {
        if (col === titlePropName) continue;
        if (!(col in schema)) continue;
        props[col] = toNotionValue(schema[col], colValues[col]);
      }
      await notion.pages.create({ parent: { database_id: databaseId }, properties: props });
      await pool.query(`UPDATE order_scan_events SET notion_synced_at = NOW() WHERE id = $1`, [h.id]);
      uploaded++;
    } catch (rowErr: any) {
      console.error(`[notion-sync] row ${i + 1} insert failed:`, rowErr?.message);
      errors.push(`Row ${i + 1}: ${rowErr?.message}`);
      if (errors.length >= 5) break;
    }
  }

  return { fetched: rows.length, uploaded, errors, databaseId, url };
}

// ── Persisted config so the auto-sync reuses the last manual upload's target + columns ──
export async function getScanHistoryNotionConfig(): Promise<{ pageId: string | null; columns: string[] | null } | null> {
  const { rows } = await pool.query(`SELECT page_id AS "pageId", columns FROM scan_history_notion_config WHERE id = 1`);
  if (!rows[0]) return null;
  let columns: string[] | null = null;
  const c = rows[0].columns;
  if (Array.isArray(c)) columns = c;
  else if (typeof c === 'string') { try { const p = JSON.parse(c); if (Array.isArray(p)) columns = p; } catch { /* leave null */ } }
  return { pageId: rows[0].pageId ?? null, columns };
}

export async function saveScanHistoryNotionConfig(pageId: string, columns: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO scan_history_notion_config (id, page_id, columns, updated_at)
     VALUES (1, $1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET page_id = EXCLUDED.page_id, columns = EXCLUDED.columns, updated_at = NOW()`,
    [pageId, JSON.stringify(columns ?? [])],
  );
}

// ── The 30-minute background job ─────────────────────────────────────────────
// Pushes every not-yet-synced scan row across ALL plants (system-wide, no user scoping) to the
// last-configured Notion DB, using the last manual upload's columns (or the full default set).
// No-ops quietly when nothing is configured, so it's safe to schedule unconditionally.
export async function runAutoScanHistorySync(): Promise<void> {
  if (syncInProgress) {
    console.log('[notion-auto-sync] previous run still in progress — skipping this tick');
    return;
  }
  const secret = (process.env.NOTION_INTEGRATION_SECRET ?? '').trim();
  const cfg = await getScanHistoryNotionConfig().catch(() => null);
  const pageId = (cfg?.pageId && cfg.pageId.trim()) || process.env.SCAN_HISTORY_NOTION_DB_ID || '';
  if (!secret || !pageId) {
    // Not configured yet (no manual upload has saved a target, no env var) — nothing to do.
    return;
  }

  syncInProgress = true;
  try {
    const result = await pushScanHistoryToNotion({
      pageId,
      columns: cfg?.columns ?? null,
      allowedPlants: null, // system job: every plant
    });
    if (result.uploaded > 0 || result.errors.length > 0) {
      console.log(`[notion-auto-sync] pushed ${result.uploaded}/${result.fetched} scan row(s) to Notion${result.errors.length ? ` — ${result.errors.length} error(s)` : ''}`);
    }
  } catch (e) {
    console.error('[notion-auto-sync] failed:', e instanceof Error ? e.message : e);
  } finally {
    syncInProgress = false;
  }
}
