import { Client } from '@notionhq/client';
import { findOrderPageIds } from './notionOrderStatusSync';
import { pool } from '../db';

// What Vehicle Planning reads from Notion on request (never on a timer): the driver list (name + page id, because the order's "Driver :" is a
// relation and needs the page id), and one order's trip days and driver.

export type NotionDriver = { id: string; name: string };

// Same company the Expense Voucher driver search uses.
const DRIVER_COMPANY = 'KRUPA MARKETING';
const DRIVER_LIST_TTL_MS = 10 * 60 * 1000;
let driverCache: { drivers: NotionDriver[]; at: number } | null = null;
let driverRefresh: Promise<NotionDriver[]> | null = null;

const client = () => new Client({ auth: process.env.NOTION_INTEGRATION_SECRET, timeoutMs: 30000 });
const plain = (items: any[] | undefined) => (items ?? []).map((t: any) => t.plain_text || '').join('').trim();

async function fetchDrivers(): Promise<NotionDriver[]> {
  const databaseId = process.env.DRIVER_DATABASE_ID?.trim();
  if (!databaseId || !process.env.NOTION_INTEGRATION_SECRET) throw new Error('Notion is not configured for the driver list');
  const notion = client();
  const out = new Map<string, NotionDriver>();
  let cursor: string | undefined;
  for (let batch = 0; batch < 10; batch++) {
    const resp: any = await notion.databases.query({ database_id: databaseId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const page of resp.results as any[]) {
      if (!page.properties) continue;
      if (page.properties['Company :']?.select?.name !== DRIVER_COMPANY) continue;
      const title = Object.values(page.properties).find((p: any) => p.type === 'title') as any;
      const name = plain(title?.title);
      if (name) out.set(page.id, { id: page.id, name });
    }
    if (!resp.has_more) break;
    cursor = resp.next_cursor ?? undefined;
  }
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// The driver list comes from Driver Master (our own table, filled by its "Sync from Notion"), so Notion is not read each time a driver is picked. Only while that table
// is still empty does it fall back to reading Notion, as before.
export async function listNotionDrivers(): Promise<NotionDriver[]> {
  try {
    const { rows } = await pool.query(`SELECT notion_page_id AS id, name FROM driver_master WHERE in_notion ORDER BY name`);
    if (rows.length > 0) return rows as NotionDriver[];
  } catch { /* the table is not there yet: use Notion */ }
  if (driverCache && Date.now() - driverCache.at < DRIVER_LIST_TTL_MS) return driverCache.drivers;
  if (!driverRefresh) {
    driverRefresh = fetchDrivers()
      .then((drivers) => { driverCache = { drivers, at: Date.now() }; return drivers; })
      .finally(() => { driverRefresh = null; });
  }
  try { return await driverRefresh; } catch (error) {
    if (driverCache) return driverCache.drivers; // a failed refresh keeps the last good list
    throw error;
  }
}

export type NotionOrderInfo = { tripDays: number | null; driver: NotionDriver | null };

// The order's "Party Trips (Days)" and its "Driver :" relation, read from the first matching Notion page. Null when Notion cannot be reached or has no such order.
export async function readNotionOrderInfo(orderNumber: string): Promise<NotionOrderInfo | null> {
  const orderDatabaseId = process.env.ORDER_DATABASE_ID?.trim();
  if (!orderDatabaseId || !process.env.NOTION_INTEGRATION_SECRET) return null;
  try {
    const notion = client();
    const [pageId] = await findOrderPageIds(notion, orderDatabaseId, orderNumber);
    if (!pageId) return null;
    const page: any = await notion.pages.retrieve({ page_id: pageId });
    const daysProp = page.properties?.['Party Trips (Days)'];
    let raw: any = null;
    if (daysProp?.type === 'number') raw = daysProp.number;
    else if (daysProp?.type === 'formula') raw = daysProp.formula?.number ?? daysProp.formula?.string;
    else if (daysProp?.type === 'rollup') raw = daysProp.rollup?.number ?? daysProp.rollup?.array?.[0]?.number;
    else if (daysProp?.type === 'rich_text') raw = plain(daysProp.rich_text);
    const n = parseInt(String(raw ?? ''), 10);
    const driverRel: any[] = page.properties?.['Driver :']?.relation ?? [];
    let driver: NotionDriver | null = null;
    if (driverRel[0]?.id) {
      const known = (await listNotionDrivers().catch(() => [])).find((d) => d.id.replace(/-/g, '') === String(driverRel[0].id).replace(/-/g, ''));
      if (known) driver = known;
      else {
        const dp: any = await notion.pages.retrieve({ page_id: driverRel[0].id });
        const title = Object.values(dp.properties ?? {}).find((p: any) => p.type === 'title') as any;
        const name = plain(title?.title);
        if (name) driver = { id: driverRel[0].id, name };
      }
    }
    return { tripDays: Number.isFinite(n) && n >= 1 ? n : null, driver };
  } catch (error) {
    console.error('[Vehicle Planning] Could not read the order from Notion:', error instanceof Error ? error.message : error);
    return null;
  }
}
