import type { PoolClient, Pool } from 'pg';

// Unloading can name TWO plants for a batch (a whole CSV, chosen once at import and locked):
//   - the STOCK plant   (unload_import_sessions.plant)          — where the boxes are added to the live
//     count and later loaded from. This is what every scan has always used.
//   - the PURCHASE plant (unload_import_sessions.purchase_plant) — the plant the purchase belongs to.
//     Null / the same name = one plant, exactly the old behaviour.
//
// The live count (product_plant_stock) only ever changes at the STOCK plant — that is unchanged. What
// this adds is the LEDGER (stock_movements), which Overall Stock reads: when the two plants differ,
// every unloading stock change is written as three rows that net to the live count:
//   1. the purchase side at the PURCHASE plant (a normal receive / void / correction row),
//   2. a transfer OUT at the purchase plant (transfer_dir 'out', other_plant = the stock plant),
//   3. a transfer IN at the stock plant     (transfer_dir 'in',  other_plant = the purchase plant).
// All dated by the batch's own order date through session_id, exactly like a purchase. A void or a
// correction passes a negative qty, so the same three rows reverse each other.

type Db = PoolClient | Pool;

export async function getUnloadPlants(client: Db, sessionId: number): Promise<{ stockPlant: string; purchasePlant: string }> {
  const { rows } = await client.query(`SELECT plant, purchase_plant AS "purchasePlant" FROM unload_import_sessions WHERE id = $1`, [sessionId]);
  const stockPlant = String(rows[0]?.plant ?? '');
  const purchase = String(rows[0]?.purchasePlant ?? '').trim();
  return { stockPlant, purchasePlant: purchase && purchase.toLowerCase() !== stockPlant.toLowerCase() ? purchase : stockPlant };
}

export async function postUnloadMovement(client: Db, p: {
  sessionId: number;
  barcode: string;
  productId?: number | null;
  /** Signed change in boxes at the stock plant: + a receive, − a void / correction / rollback. */
  qty: number;
  extraQty?: number;
  type: 'receive' | 'adjust';
  origin?: string | null;
  reason: string;
  userCode?: string | null;
}): Promise<void> {
  const { stockPlant, purchasePlant } = await getUnloadPlants(client, p.sessionId);
  const sameName = stockPlant.toLowerCase() === purchasePlant.toLowerCase();
  const insert = (plant: string, qty: number, extra: number, type: string, origin: string | null, reason: string, dir: string | null, other: string | null) =>
    client.query(
      `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, session_id, created_by_code, source, origin, transfer_dir, other_plant)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unloading',$10,$11,$12)`,
      [p.barcode, p.productId ?? null, plant, qty, extra, type, reason, p.sessionId, p.userCode ?? null, origin, dir, other],
    );

  // Purchase side — at the purchase plant when there is a different one, otherwise the stock plant.
  await insert(purchasePlant, p.qty, p.extraQty ?? 0, p.type, p.origin ?? null, p.reason, null, null);
  if (sameName || p.qty === 0) return;

  const note = `Transfer ${purchasePlant} → ${stockPlant}: ${p.reason}`;
  await insert(purchasePlant, -p.qty, 0, 'transfer', 'transfer', note, 'out', stockPlant);
  await insert(stockPlant, p.qty, 0, 'transfer', 'transfer', note, 'in', purchasePlant);
}
