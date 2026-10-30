import { Client } from '@notionhq/client';
import { pool } from '../db';

// Driver Master: every driver of the Notion driver database (DRIVER_DATABASE_ID), kept in our own table `driver_master`. Vehicle Planning (and the Vehicle Master driver box)
// pick a driver from this table, so Notion is not read each time one is assigned. It is refreshed only when somebody presses "Sync from Notion" on the Driver Master page.

export type DriverMasterRow = {
  id: number; notionPageId: string; name: string; company: string | null; phone: string | null; phone2: string | null;
  licenceType: string | null; licenceExp: string | null; driverNo: string | null; inNotion: boolean; syncedAt: string | null;
};

const plain = (items: any[] | undefined) => (items ?? []).map((t: any) => t.plain_text || '').join('').trim();
const clean = (v: unknown): string | null => { const s = String(v ?? '').trim(); return s ? s : null; };

// Notion property names of the driver database (confirmed against the live schema).
const PROPS = { company: 'Company :', phone: '1', phone2: '2', licenceType: 'Licence Type :', licenceExp: 'Licence Exp Date :', driverNo: 'ID' } as const;

type Parsed = { notionPageId: string; name: string; company: string | null; phone: string | null; phone2: string | null; licenceType: string | null; licenceExp: string | null; driverNo: string | null };

// The licence date is typed into Notion as text and often ends with @mentions of the people who edited it ("2027-01-06 @NIKUNJ PATEL @Anonymous"); only the date is kept
// (the mentions are not wanted, and Notion does not always return them the same way). Text with no leading date is kept as written.
function licenceDate(raw: string | null): string | null {
  const m = raw?.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : raw;
}

function parsePage(page: any): Parsed | null {
  const p = page.properties ?? {};
  const title = Object.values(p).find((x: any) => x.type === 'title') as any;
  const name = plain(title?.title);
  if (!name) return null;
  const uid = p[PROPS.driverNo]?.unique_id;
  return {
    notionPageId: page.id as string,
    name,
    company: clean(p[PROPS.company]?.select?.name),
    phone: clean(p[PROPS.phone]?.phone_number),
    phone2: clean(p[PROPS.phone2]?.phone_number),
    licenceType: clean(p[PROPS.licenceType]?.select?.name),
    licenceExp: licenceDate(clean(plain(p[PROPS.licenceExp]?.rich_text))),
    driverNo: uid && uid.number != null ? `${uid.prefix ? `${uid.prefix}-` : ''}${uid.number}` : null,
  };
}

async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await task(); } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw lastError;
}

// Reads every driver from Notion (all companies) and updates driver_master: new drivers are added, changed ones updated, and a driver that is no longer in Notion is marked
// so (it stops being offered, but is not deleted). Only the properties above are asked for, so it is quick.
export async function syncDriversFromNotion(): Promise<{ total: number; created: number; changed: number; unchanged: number; removed: number }> {
  const databaseId = process.env.DRIVER_DATABASE_ID?.trim();
  const secret = (process.env.NOTION_INTEGRATION_SECRET ?? process.env.NOTION_API_KEY ?? '').trim();
  if (!databaseId || !secret) throw new Error('Notion is not configured for the driver list (DRIVER_DATABASE_ID / NOTION_INTEGRATION_SECRET).');
  const notion = new Client({ auth: secret, timeoutMs: 60000 });
  const database: any = await withRetry(() => notion.databases.retrieve({ database_id: databaseId }));
  const titleId = (Object.values(database.properties ?? {}).find((x: any) => x.type === 'title') as any)?.id;
  const ids = [titleId, ...Object.values(PROPS).map((n) => database.properties?.[n]?.id)].filter(Boolean) as string[];

  const found = new Map<string, Parsed>();
  let cursor: string | undefined;
  for (let batch = 0; batch < 100; batch++) {
    const resp: any = await withRetry(() => notion.databases.query({ database_id: databaseId, page_size: 100, filter_properties: ids, ...(cursor ? { start_cursor: cursor } : {}) } as any));
    for (const page of resp.results as any[]) { const d = parsePage(page); if (d) found.set(d.notionPageId, d); }
    if (!resp.has_more) break;
    cursor = resp.next_cursor ?? undefined;
  }

  const { rows: existing } = await pool.query(`SELECT notion_page_id AS "id", name, company, phone, phone2, licence_type AS "licenceType", licence_exp AS "licenceExp", driver_no AS "driverNo", in_notion AS "inNotion" FROM driver_master`);
  const byId = new Map<string, any>(existing.map((r: any) => [r.id, r]));
  let created = 0, changed = 0, unchanged = 0;
  for (const d of Array.from(found.values())) {
    const old = byId.get(d.notionPageId);
    if (!old) {
      await pool.query(
        `INSERT INTO driver_master (notion_page_id, name, company, phone, phone2, licence_type, licence_exp, driver_no, in_notion, synced_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NOW(),NOW())`,
        [d.notionPageId, d.name, d.company, d.phone, d.phone2, d.licenceType, d.licenceExp, d.driverNo],
      );
      created++;
    } else if (old.name !== d.name || old.company !== d.company || old.phone !== d.phone || old.phone2 !== d.phone2 || old.licenceType !== d.licenceType || old.licenceExp !== d.licenceExp || old.driverNo !== d.driverNo || !old.inNotion) {
      await pool.query(
        `UPDATE driver_master SET name=$2, company=$3, phone=$4, phone2=$5, licence_type=$6, licence_exp=$7, driver_no=$8, in_notion=true, synced_at=NOW(), updated_at=NOW() WHERE notion_page_id=$1`,
        [d.notionPageId, d.name, d.company, d.phone, d.phone2, d.licenceType, d.licenceExp, d.driverNo],
      );
      changed++;
    } else {
      unchanged++;
    }
  }
  await pool.query(`UPDATE driver_master SET synced_at = NOW() WHERE in_notion AND notion_page_id = ANY($1::text[])`, [Array.from(found.keys())]);
  const gone = await pool.query(`UPDATE driver_master SET in_notion = false, updated_at = NOW() WHERE in_notion AND NOT (notion_page_id = ANY($1::text[]))`, [Array.from(found.keys())]);
  return { total: found.size, created, changed, unchanged, removed: gone.rowCount ?? 0 };
}

export async function listLocalDrivers(opts: { onlyInNotion?: boolean } = {}): Promise<DriverMasterRow[]> {
  const { rows } = await pool.query(
    `SELECT id, notion_page_id AS "notionPageId", name, company, phone, phone2, licence_type AS "licenceType", licence_exp AS "licenceExp", driver_no AS "driverNo",
            in_notion AS "inNotion", synced_at AS "syncedAt"
       FROM driver_master ${opts.onlyInNotion ? 'WHERE in_notion' : ''} ORDER BY name`,
  );
  return rows.map((r: any) => ({ ...r, syncedAt: r.syncedAt ? new Date(r.syncedAt).toISOString() : null }));
}
