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
