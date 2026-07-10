import { Client as NotionClient } from '@notionhq/client';
import { pool } from '../db';

// ── Auto-push each scan event to Notion as it happens ────────────────────────
// Mirrors the row shape/property-mapping used by the manual "Upload to Notion"
// button (server/routes/scan-sessions.ts, POST /reports/upload-to-notion), but
// runs automatically right after each scan is committed, one row at a time via
// a FIFO queue so we never fire concurrent requests at Notion's rate limit.
//
// If a push fails, the row's `notion_synced_at` stays NULL — the existing
// manual upload button will still pick it up later, so it doubles as a
// backfill/retry mechanism without any extra code.

const ALL_COLUMNS = [
  '#', 'Scanned By', 'Code', 'Item', 'Barcode', 'Order', 'Plant',
  'Qty', 'Pallets', 'STV', 'Type', 'Time',
] as const;

let schemaCache: { databaseId: string; schema: Record<string, string>; titlePropName: string } | null = null;
let schemaCachePromise: Promise<typeof schemaCache> | null = null;

function isConfigured(): boolean {
  return Boolean(process.env.NOTION_INTEGRATION_SECRET && process.env.SCAN_HISTORY_NOTION_DB_ID);
}

function toNotionValue(propType: string, value: any): any {
  const str = String(value ?? '');
  switch (propType) {
    case 'title':     return { title:     [{ text: { content: str } }] };
    case 'rich_text': return { rich_text: [{ text: { content: str } }] };
    case 'number':    return { number: isNaN(parseFloat(str)) ? 0 : parseFloat(str) };
    case 'select':    return str ? { select: { name: str } } : { select: null };
    case 'date': {
      try {
        const d = new Date(value);
        if (!isNaN(d.getTime())) return { date: { start: d.toISOString() } };
      } catch {}
      return { date: null };
    }
    case 'checkbox': return { checkbox: Boolean(value) };
    default:         return { rich_text: [{ text: { content: str } }] };
  }
}

async function ensureSchema(notion: NotionClient): Promise<NonNullable<typeof schemaCache>> {
  if (schemaCache) return schemaCache;
  if (!schemaCachePromise) {
    schemaCachePromise = (async () => {
      const raw = process.env.SCAN_HISTORY_NOTION_DB_ID!;
      const hexMatch = raw.match(/([a-f0-9]{32})/i);
      if (!hexMatch) throw new Error('SCAN_HISTORY_NOTION_DB_ID is not a valid Notion database ID');
      const hex = hexMatch[1];
      const databaseId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;

      const existingDb = await notion.databases.retrieve({ database_id: databaseId }) as any;
      const schema: Record<string, string> = {};
      for (const [name, prop] of Object.entries(existingDb.properties ?? {})) {
        schema[name] = (prop as any).type;
      }
      const titlePropName = Object.entries(schema).find(([, t]) => t === 'title')?.[0] ?? 'Name';

      const propsToAdd: Record<string, any> = {};
      for (const col of ALL_COLUMNS) {
        if (col in schema || col === '#') continue;
        if (['Qty', 'Pallets'].includes(col))    propsToAdd[col] = { number: {} };
        else if (['Plant', 'Type'].includes(col)) propsToAdd[col] = { select: {} };
        else                                       propsToAdd[col] = { rich_text: {} };
      }
      if (Object.keys(propsToAdd).length > 0) {
        await notion.databases.update({ database_id: databaseId, properties: propsToAdd });
        for (const [col, def] of Object.entries(propsToAdd)) schema[col] = Object.keys(def)[0];
      }

      schemaCache = { databaseId, schema, titlePropName };
      return schemaCache;
    })().catch((err) => {
      schemaCachePromise = null; // allow retry on the next enqueued event
      throw err;
    });
  }
  return schemaCachePromise as Promise<NonNullable<typeof schemaCache>>;
}

async function pushOneEvent(eventId: number): Promise<void> {
  const { rows } = await pool.query(
    `SELECT
       ose.id, ose.barcode, ose.item_name AS "itemName", ose.pallets,
       ose.total_qty AS "totalQty", ose.is_extra AS "isExtra", ose.stv,
       ose.scanned_by_code AS "scannedByCode", ose.scanned_by_name AS "scannedByName",
       ose.scanned_at AS "scannedAt",
       ois.csv_file_name AS "orderName", ois.plant
     FROM order_scan_events ose
     JOIN order_import_sessions ois ON ois.id = ose.session_id
     WHERE ose.id = $1 AND ose.notion_synced_at IS NULL`,
    [eventId],
  );
  const h = rows[0];
  if (!h) return; // already synced (e.g. via manual upload) or event no longer exists

  const notion = new NotionClient({ auth: process.env.NOTION_INTEGRATION_SECRET });
  const { databaseId, schema, titlePropName } = await ensureSchema(notion);

  const colValues: Record<string, any> = {
    '#':          String(h.id),
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
    [titlePropName]: toNotionValue('title', colValues[titlePropName] ?? String(h.id)),
  };
  for (const col of ALL_COLUMNS) {
    if (col === titlePropName || !(col in schema)) continue;
    props[col] = toNotionValue(schema[col], colValues[col]);
  }

  await notion.pages.create({ parent: { database_id: databaseId }, properties: props });
  await pool.query(`UPDATE order_scan_events SET notion_synced_at = NOW() WHERE id = $1`, [h.id]);
}

const queue: number[] = [];
let draining = false;

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const eventId = queue.shift()!;
      try {
        await pushOneEvent(eventId);
      } catch (err: any) {
        console.error(`[notionScanSync] Failed to auto-push scan event ${eventId} to Notion:`, err?.message ?? err);
        // Left unsynced — the manual "Upload to Notion" button will retry it later.
      }
    }
  } finally {
    draining = false;
  }
}

/** Fire-and-forget: queue a just-recorded scan event for an automatic Notion push. */
export function enqueueScanEventForNotion(eventId: number): void {
  if (!isConfigured()) return; // feature not set up — no-op, manual upload still works
  queue.push(eventId);
  void drainQueue();
}
