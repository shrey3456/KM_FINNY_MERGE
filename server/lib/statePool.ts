// State-wide stock pooling for Loading. A plant's stock is normally tracked one row per
// (barcode, plant) in product_plant_stock — Loading has always checked/decremented against
// exactly the plant doing the loading. This lets it instead draw on every plant that shares the
// same state (plants.state — e.g. Valsad and Vadodra are both "Gj"), so loading at Valsad can
// use stock that's physically sitting at Vadodra too.
//
// Pull order (confirmed): the loading plant's own stock is used first — this preserves today's
// exact behavior whenever a plant already has enough on its own — and only the shortfall is
// pulled from other same-state plants, largest stock first.
//
// Every debit is recorded per contributing plant (server/routes/loading.ts persists this to
// loading_stock_pulls, keyed by the loading_scan_events row it belongs to), so a later void/
// reset credits stock back to the exact plant(s) it actually came from — never just the loading
// plant's own row, which would otherwise leave a borrowed-from plant permanently short.
import type { Pool, PoolClient } from 'pg';
import { reconcileProductPlantStockBarcode } from './stockBarcodeReconcile';

type DbClient = Pool | PoolClient;

export interface StockPullContribution {
  plant: string;
  qty: number;
}

// Every plant sharing `plant`'s state (case/whitespace-insensitive on the state code), plant
// itself always included. Falls back to just [plant] when the plant has no state configured yet
// (Plant Management) — same as today's plant-only behavior, rather than silently pooling across
// every unconfigured plant. Sorted by name for a STABLE lock order: every caller locking this
// same set of rows (debitStatePool below) always requests them in the same sequence, so two
// concurrent loads against different plants in the same state can't deadlock each other.
export async function getStatePlantNames(client: DbClient, plant: string): Promise<string[]> {
  if (!plant) return [];
  const { rows } = await client.query(`SELECT state FROM plants WHERE LOWER(name) = LOWER($1) LIMIT 1`, [plant]);
  const state = rows[0]?.state ? String(rows[0].state).trim() : '';
  if (!state) return [plant];
  const { rows: siblings } = await client.query(
    `SELECT name FROM plants WHERE LOWER(TRIM(state)) = LOWER($1) ORDER BY LOWER(name)`,
    [state],
  );
  const names: string[] = siblings.map((r: any) => r.name);
  // Plant itself might have no product_plant_stock row yet, or might somehow not come back from
  // the siblings query (shouldn't happen — it matched its own state above) — guarantee it's in
  // the set either way, since it's still where the load is physically happening.
  if (!names.some((n) => n.toLowerCase() === plant.toLowerCase())) names.push(plant);
  return names;
}

// Unlocked, cheap pooled total — for a fast "is there anything at all" precheck before opening a
// transaction. Not authoritative on its own (see the same caveat the old single-plant precheck
// carried) — debitStatePool's own locked read is what actually prevents overselling under
// concurrent scans.
export async function getPooledStock(
  client: DbClient,
  barcode: string,
  plant: string,
): Promise<{ total: number; statePlants: string[]; byPlant: Map<string, number> }> {
  const statePlants = await getStatePlantNames(client, plant);
  const { rows } = await client.query(
    `SELECT plant, in_stock AS "inStock" FROM product_plant_stock WHERE barcode = $1 AND plant = ANY($2::text[])`,
    [barcode, statePlants],
  );
  const byPlant = new Map<string, number>(statePlants.map((p) => [p, 0]));
  for (const r of rows) byPlant.set(r.plant, r.inStock ?? 0);
  const total = [...byPlant.values()].reduce((s, v) => s + v, 0);
  return { total, statePlants, byPlant };
}

// Locks every same-state plant's row for this barcode (FOR UPDATE, in getStatePlantNames' stable
// order), verifies the STATE has enough, then debits: `plant`'s own stock first, then the
// shortfall from other same-state plants ordered by current stock, largest first. Returns
// exactly what was taken from each plant. Safe to call more than once against the same locked
// rows within one transaction (e.g. once for a scan's regular portion, again for its extra
// portion) — each call re-reads the current (already-locked, already-updated-by-earlier-calls-
// in-this-transaction) values.
export async function debitStatePool(
  client: DbClient,
  barcode: string,
  plant: string,
  qty: number,
  productId: number | null | undefined,
): Promise<StockPullContribution[]> {
  if (qty <= 0) return [];
  const statePlants = await getStatePlantNames(client, plant);
  const { rows } = await client.query(
    `SELECT plant, in_stock AS "inStock" FROM product_plant_stock
     WHERE barcode = $1 AND plant = ANY($2::text[]) FOR UPDATE`,
    [barcode, statePlants],
  );
  const stockByPlant = new Map<string, number>(statePlants.map((p) => [p, 0]));
  for (const r of rows) stockByPlant.set(r.plant, r.inStock ?? 0);

  const total = [...stockByPlant.values()].reduce((s, v) => s + v, 0);
  if (total < qty) {
    throw Object.assign(
      new Error(
        statePlants.length > 1
          ? `Only ${total} in stock across ${plant}'s state (${statePlants.join(', ')}) — cannot load ${qty}.`
          : `Only ${total} in stock at ${plant} — cannot load ${qty}.`,
      ),
      { status: 409 },
    );
  }

  const contributions: StockPullContribution[] = [];
  let remaining = qty;

  const ownAvailable = stockByPlant.get(plant) ?? 0;
  if (ownAvailable > 0) {
    const take = Math.min(ownAvailable, remaining);
    contributions.push({ plant, qty: take });
    remaining -= take;
  }

  if (remaining > 0) {
    const others = [...stockByPlant.entries()]
      .filter(([p]) => p !== plant && p !== undefined)
      .sort((a, b) => b[1] - a[1]); // largest stock first
    for (const [p, avail] of others) {
      if (remaining <= 0) break;
      if (avail <= 0) continue;
      const take = Math.min(avail, remaining);
      contributions.push({ plant: p, qty: take });
      remaining -= take;
    }
  }

  for (const c of contributions) {
    await reconcileProductPlantStockBarcode(client, productId, c.plant, barcode);
    await client.query(
      `UPDATE product_plant_stock SET in_stock = in_stock - $1, updated_at = NOW()
       WHERE barcode = $2 AND LOWER(TRIM(plant)) = LOWER(TRIM($3))`,
      [c.qty, barcode, c.plant],
    );
  }
  return contributions;
}

// The reversal primitive — adds each contribution's qty back to the plant it came from. Used
// directly when the caller already has the contributions in hand (right after debiting, on an
// error path), and via reverseStockPullsForEvent below once they've been persisted.
export async function creditStatePool(
  client: DbClient,
  barcode: string,
  contributions: StockPullContribution[],
): Promise<void> {
  for (const c of contributions) {
    if (!c.qty) continue;
    await client.query(
      `UPDATE product_plant_stock SET in_stock = in_stock + $1, updated_at = NOW()
       WHERE barcode = $2 AND LOWER(TRIM(plant)) = LOWER(TRIM($3))`,
      [c.qty, barcode, c.plant],
    );
  }
}

// Persists a debit's per-plant breakdown against the loading_scan_events row it belongs to, so
// a later void/reset can credit back exactly where it came from instead of assuming the loading
// plant's own row.
export async function recordStockPulls(
  client: DbClient,
  loadingScanEventId: number,
  contributions: StockPullContribution[],
): Promise<void> {
  for (const c of contributions) {
    if (!c.qty) continue;
    await client.query(
      `INSERT INTO loading_stock_pulls (loading_scan_event_id, source_plant, qty) VALUES ($1, $2, $3)`,
      [loadingScanEventId, c.plant, c.qty],
    );
  }
}

// Reads back and credits an event's exact pull breakdown, then clears those rows (an event is
// only ever reversed once — void and reset both route through this, and reset processes events
// that aren't already voided). Returns the contributions it credited, empty for an event with no
// pull rows — either it predates this table, or it never actually contributed anywhere (0 qty)
// — so the caller can fall back to the old plant-only credit for that case, and can log its own
// per-plant stock_movements rows from what's returned here.
export async function reverseStockPullsForEvent(
  client: DbClient,
  loadingScanEventId: number,
  barcode: string,
): Promise<StockPullContribution[]> {
  const { rows } = await client.query(
    `SELECT source_plant AS plant, qty FROM loading_stock_pulls WHERE loading_scan_event_id = $1`,
    [loadingScanEventId],
  );
  const contributions = rows as StockPullContribution[];
  if (contributions.length === 0) return contributions;
  await creditStatePool(client, barcode, contributions);
  await client.query(`DELETE FROM loading_stock_pulls WHERE loading_scan_event_id = $1`, [loadingScanEventId]);
  return contributions;
}
