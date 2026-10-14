import type { PoolClient, Pool } from 'pg';
import { v2Purchase, v2Transfer, resolveLine, linkKey, csvSapFor, lockLineStock } from './stockV2';

// Unloading can name TWO plants for a batch (a whole CSV, chosen once at import and locked):
//   - the STOCK plant   (unload_import_sessions.plant)          - where the boxes end up and are later loaded from.
//   - the PURCHASE plant (unload_import_sessions.purchase_plant) - the plant the purchase belongs to.
//     Null / the same name = one plant.
//
// Everything is on Stock Overview: the receive is a purchase at the PURCHASE plant's line; when the two plants differ it is followed by a transfer
// out of the purchase plant's line and a transfer in on the stock plant's line, so the boxes land at the stock plant. A void or a correction
// passes a negative qty, so the same postings reverse each other. All booked on the scan's own day.

type Db = PoolClient | Pool;

// The day an unloading scan is booked on: today, India time. Stored on the scan (unload_scan_events.booked_day) so a later void or correction
// can be booked on that same day.
export const scanDay = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export async function getUnloadPlants(client: Db, sessionId: number): Promise<{ stockPlant: string; purchasePlant: string }> {
  const { rows } = await client.query(`SELECT plant, purchase_plant AS "purchasePlant" FROM unload_import_sessions WHERE id = $1`, [sessionId]);
  const stockPlant = String(rows[0]?.plant ?? '');
  const purchase = String(rows[0]?.purchasePlant ?? '').trim();
  return { stockPlant, purchasePlant: purchase && purchase.toLowerCase() !== stockPlant.toLowerCase() ? purchase : stockPlant };
}

// The stock plant's line this batch's barcode lands on (the same line a receive posts to when there is one plant), made when it has none yet.
export async function unloadStockLine(client: Db, sessionId: number, barcode: string) {
  const { stockPlant } = await getUnloadPlants(client, sessionId);
  const sap = await csvSapFor(client, 'unload', sessionId, barcode);
  return resolveLine(client, 'unload_session', linkKey(sap ? [sessionId, barcode, stockPlant, sap] : [sessionId, barcode, stockPlant]), stockPlant, barcode, sap);
}

// The boxes now on that line (locked), so a void / correction / rollback can refuse to take back boxes that were already loaded out.
export async function unloadStockLeft(client: Db, sessionId: number, barcode: string): Promise<number> {
  const line = await unloadStockLine(client, sessionId, barcode);
  return line ? lockLineStock(client, line.id) : 0;
}

export async function postUnloadMovement(client: Db, p: {
  sessionId: number;
  barcode: string;
  productId?: number | null;
  /** Signed change in boxes at the stock plant: + a receive, - a void / correction / rollback. */
  qty: number;
  extraQty?: number;
  type: 'receive' | 'adjust';
  origin?: string | null;
  reason: string;
  userCode?: string | null;
  /** The day this stock row counts on (YYYY-MM-DD): the scan booked day. Empty = the CSV order date. */
  day?: string | null;
}): Promise<void> {
  const { stockPlant, purchasePlant } = await getUnloadPlants(client, p.sessionId);
  const sameName = stockPlant.toLowerCase() === purchasePlant.toLowerCase();
  // Purchase at the purchase plant (or the stock plant when there is no other one), on the batch day.
  await v2Purchase(client, { source: 'unload', sessionId: p.sessionId, plant: purchasePlant, barcode: p.barcode, qty: p.qty, extraQty: p.extraQty ?? 0, day: p.day ?? null });
  if (sameName || p.qty === 0) return;
  await v2Transfer(client, { sessionId: p.sessionId, purchasePlant, stockPlant, barcode: p.barcode, qty: p.qty, day: p.day ?? null });
}
