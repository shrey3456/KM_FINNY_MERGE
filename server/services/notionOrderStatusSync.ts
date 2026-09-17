// Pushes Loading-page status changes back to Notion's ORDER database "Finny Status :" property
// — the same field server/services/proformaNotionSync.ts already reads FROM Notion into
// proforma_slips.notionStatus, so this keeps that field a real two-way sync instead of one-way.
//
// Best-effort by design: every call catches and logs its own errors rather than throwing, so a
// slow/unreachable Notion API never blocks or fails the actual Loading action (linking a
// vehicle, completing a load) that triggered it — the local DB write always wins; Notion is a
// mirror, not the source of truth for the app's own state.

import { Client } from '@notionhq/client';

// "Finny Status :" is a Notion status property with a fixed set of options (confirmed live
// against the database): LOADING is used while loading is in progress; READY≈DESP ("Ready for
// Despatch") once loading finishes — the vehicle is loaded and ready to leave, but hasn't
// necessarily left yet, which is what DISPATCHED would otherwise (mis)imply.
export const NOTION_LOADING_STATUS = 'LOADING';
export const NOTION_LOADING_COMPLETE_STATUS = 'READY≈DESP';

async function findOrderPageIds(notion: Client, orderDatabaseId: string, orderNumber: string): Promise<string[]> {
  const response = await notion.databases.query({
    database_id: orderDatabaseId,
    filter: { property: 'Order No. :', rich_text: { equals: orderNumber } },
  });
  return response.results.map((page: any) => page.id);
}

// "StoreKeeper & Platform info :" is a MULTI-SELECT in Notion (confirmed against the database), not
// text: the "YASH, RAHUL, PLT-05" the app stores is one tag per comma-separated part.
const STORE_KEEPER_PROPERTY = 'StoreKeeper & Platform info :';

// Existing tags on that property, cached briefly so a burst of loads doesn't re-read the database
// schema for every push.
let storeKeeperTagCache: { names: string[]; at: number } | null = null;
const STORE_KEEPER_TAG_TTL_MS = 10 * 60 * 1000;

async function existingStoreKeeperTags(notion: Client, orderDatabaseId: string): Promise<string[]> {
  if (storeKeeperTagCache && Date.now() - storeKeeperTagCache.at < STORE_KEEPER_TAG_TTL_MS) return storeKeeperTagCache.names;
  const db: any = await notion.databases.retrieve({ database_id: orderDatabaseId });
  const names: string[] = (db?.properties?.[STORE_KEEPER_PROPERTY]?.multi_select?.options ?? []).map((o: any) => String(o.name));
  storeKeeperTagCache = { names, at: Date.now() };
  return names;
}

// Uses a tag Notion already has wherever one fits, so the app doesn't pile up near-duplicates:
//   - a name ("YASH") or any part matching an existing tag, ignoring case and stray spaces, uses
//     that tag's exact spelling (some existing tags carry a trailing space, e.g. "pt: 1 ");
//   - the STV (always the last part) is matched BY ITS NUMBER to the platform tags Notion already
//     uses: "PLT-05" or "STV-05" -> the existing "pt: 5". Only a plain code-and-number is matched;
//     something like "STV-01&02" is left as it is.
// Anything with no existing match is sent as-is, and Notion creates that tag.
function resolveStoreKeeperTags(parts: string[], existing: string[]): string[] {
  const norm = (value: string) => value.trim().toUpperCase();
  const byName = new Map(existing.map((name) => [norm(name), name]));
  const platformByNumber = new Map<number, string>();
  for (const name of existing) {
    const m = /^\s*pt\s*:\s*0*(\d+)\s*$/i.exec(name);
    if (m && !platformByNumber.has(Number(m[1]))) platformByNumber.set(Number(m[1]), name);
  }
  return parts.map((part, index) => {
    const exact = byName.get(norm(part));
    if (exact) return exact;
    if (index === parts.length - 1) {
      const code = /^[A-Za-z]+\s*-\s*0*(\d+)$/.exec(part.trim());
      const platform = code ? platformByNumber.get(Number(code[1])) : undefined;
      if (platform) return platform;
    }
    return part;
  });
}

// Replaces the StoreKeeper tags on every ORDER-database page for this order with the app's current
// value. Same best-effort rules as the status push below: never throws, a Notion failure never
// blocks the Loading action that triggered it.
export async function pushStoreKeeperInfoToNotion(orderNumber: string, storeKeeperInfo: string | null | undefined): Promise<void> {
  try {
    const ORDER_DATABASE_ID = process.env.ORDER_DATABASE_ID;
    if (!ORDER_DATABASE_ID) {
      console.warn('[Notion storekeeper sync] ORDER_DATABASE_ID not set — skipping push');
      return;
    }
    const notion = new Client({ auth: process.env.NOTION_INTEGRATION_SECRET });
    // Tag names can't contain commas (Notion rejects them) and are capped at 100 characters.
    const parts = String(storeKeeperInfo ?? '')
      .split(',')
      .map((part) => part.trim().slice(0, 100))
      .filter(Boolean);
    const tags = resolveStoreKeeperTags(parts, await existingStoreKeeperTags(notion, ORDER_DATABASE_ID.trim()))
      .map((name) => ({ name }));
    const pageIds = await findOrderPageIds(notion, ORDER_DATABASE_ID.trim(), orderNumber);
    if (pageIds.length === 0) {
      console.warn(`[Notion storekeeper sync] No Order DB page found for order ${orderNumber} — skipping push`);
      return;
    }
    await Promise.all(
      pageIds.map((pageId) =>
        notion.pages.update({
          page_id: pageId,
          properties: { [STORE_KEEPER_PROPERTY]: { multi_select: tags } } as any,
        }),
      ),
    );
    console.log(`[Notion storekeeper sync] Order ${orderNumber} -> "${tags.map((t) => t.name).join(', ')}" (${pageIds.length} page(s))`);
  } catch (error) {
    console.error(`[Notion storekeeper sync] Failed to push StoreKeeper Info for order ${orderNumber}:`, error instanceof Error ? error.message : error);
  }
}

// Sets "Finny Status :" to statusName on every ORDER-database page matching this order number
// (an order number can have more than one row there) — never throws; logs and returns silently
// on any failure (missing env vars, Notion API error, no matching page, etc).
export async function pushOrderStatusToNotion(orderNumber: string, statusName: string): Promise<void> {
  try {
    const ORDER_DATABASE_ID = process.env.ORDER_DATABASE_ID;
    if (!ORDER_DATABASE_ID) {
      console.warn('[Notion status sync] ORDER_DATABASE_ID not set — skipping status push');
      return;
    }
    const notion = new Client({ auth: process.env.NOTION_INTEGRATION_SECRET });
    const pageIds = await findOrderPageIds(notion, ORDER_DATABASE_ID.trim(), orderNumber);
    if (pageIds.length === 0) {
      console.warn(`[Notion status sync] No Order DB page found for order ${orderNumber} — skipping status push to "${statusName}"`);
      return;
    }
    await Promise.all(
      pageIds.map((pageId) =>
        notion.pages.update({
          page_id: pageId,
          properties: {
            'Finny Status :': { status: { name: statusName } },
          } as any,
        }),
      ),
    );
    console.log(`[Notion status sync] Order ${orderNumber} -> "${statusName}" (${pageIds.length} page(s))`);
  } catch (error) {
    console.error(`[Notion status sync] Failed to push status "${statusName}" for order ${orderNumber}:`, error instanceof Error ? error.message : error);
  }
}
