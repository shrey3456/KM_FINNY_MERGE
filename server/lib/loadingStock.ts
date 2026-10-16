import type { Pool, PoolClient } from 'pg';
import { findLineForProduct, lockLineStock, saleOnLine } from './stockV2';

// Loading's stock, on Stock Overview only. A load takes from the stock line of its PRODUCT at the slip's OWN plant - never from another plant, and
// two products that share a barcode (35 g / 37 g) are two lines, so one is never taken from the other. Every entry remembers the line it took from
// (loading_scan_events.stock_line_id), so a void, an edit or a reset gives the boxes back to exactly that line.

type Db = Pool | PoolClient;

export interface StockPull {
  plant: string;
  qty: number;
  lineId: number;
}

// What a scan of this product could take right now at this plant (0 when the product has no line there yet).
export async function availableStock(db: Db, plant: string, barcode: string, productId?: number | null): Promise<number> {
  const line = await findLineForProduct(db, plant, barcode, productId, false);
  return line ? Number(line.stockQty ?? 0) : 0;
}

// Locks the product's line at the plant and checks it can give `qty`; returns the pull to record once the entries are inserted (the sale itself
// is posted by recordSale, when the entry - and so its day and its extra part - exists). Throws a 409 when the plant has too little.
export async function takeStock(client: Db, plant: string, barcode: string, qty: number, productId?: number | null): Promise<StockPull[]> {
  if (qty <= 0) return [];
  const line = await findLineForProduct(client, plant, barcode, productId, true);
  if (!line) throw Object.assign(new Error(`"${barcode}" is not in the Product Master.`), { status: 400 });
  const stock = await lockLineStock(client, line.id);
  if (stock < qty) {
    throw Object.assign(new Error(`Only ${stock} in stock at ${plant} - cannot load ${qty}.`), { status: 409 });
  }
  return [{ plant: line.plant, qty, lineId: line.id }];
}

// Posts the sale for an inserted entry (positive total_qty) and ties the entry to the line.
export async function recordSale(client: Db, eventId: number, pulls: StockPull[]): Promise<void> {
  if (pulls.length === 0) return;
  const ev = await client.query(`SELECT order_number, is_extra FROM loading_scan_events WHERE id = $1`, [eventId]);
  const orderNumber = String(ev.rows[0]?.order_number ?? '');
  const isExtra = !!ev.rows[0]?.is_extra;
  for (const p of pulls) {
    if (!p.qty) continue;
    await client.query(`UPDATE loading_scan_events SET stock_line_id = $2 WHERE id = $1`, [eventId, p.lineId]);
    await saleOnLine(client, { lineId: p.lineId, orderNumber, qty: p.qty, extraQty: isExtra ? p.qty : 0 });
  }
}

// A manual "decrease loaded quantity": boxes go back to the product's line (a negative sale), and the adjust entries are tied to that line.
// Each event's qty is the sale it posts, so a decrease passes it negative.
export async function giveBackOnSlip(
  client: Db,
  p: { plant: string; barcode: string; productId?: number | null; orderNumber: string; events: Array<{ id: number; qty: number; isExtra: boolean }> },
): Promise<void> {
  const line = await findLineForProduct(client, p.plant, p.barcode, p.productId, true);
  if (!line) return;
  for (const e of p.events) {
    if (!e.qty) continue;
    await client.query(`UPDATE loading_scan_events SET stock_line_id = $2 WHERE id = $1`, [e.id, line.id]);
    await saleOnLine(client, { lineId: line.id, orderNumber: p.orderNumber, qty: e.qty, extraQty: e.isExtra ? e.qty : 0 });
  }
}

// Reverses one entry's stock effect (void / edit / reset): the opposite sale on the line it took from (loading_scan_events.stock_line_id).
export async function giveBack(client: Db, eventId: number): Promise<StockPull[]> {
  const ev = (await client.query(
    `SELECT id, order_number, barcode, plant, total_qty, is_extra, sap_code, stock_line_id FROM loading_scan_events WHERE id = $1`, [eventId],
  )).rows[0];
  if (!ev) return [];
  const total = Number(ev.total_qty ?? 0);
  if (!total) return [];
  const orderNumber = String(ev.order_number ?? '');
  const out: StockPull[] = [];
  const reverse = async (lineId: number, plant: string, qty: number, isExtra: boolean) => {
    // `qty` is how much the entry took (negative for a "decrease" entry); giving it back is the opposite sale.
    await saleOnLine(client, { lineId, orderNumber, qty: -qty, extraQty: isExtra ? -qty : 0 });
    out.push({ plant, qty, lineId });
  };
  if (ev.stock_line_id != null) {
    const l = await client.query(`SELECT plant FROM stock_v2_lines WHERE id = $1`, [ev.stock_line_id]);
    await reverse(Number(ev.stock_line_id), String(l.rows[0]?.plant ?? ev.plant), total, !!ev.is_extra);
    return out;
  }
  // An entry without a stock line (should not exist): back to its own plant's line for the product, found by its SAP code when it has one.
  const sources: Array<{ plant: string; qty: number }> = [{ plant: ev.plant, qty: total }];
  const sap = ev.sap_code ? String(ev.sap_code) : null;
  for (const s of sources) {
    // by SAP code when the entry has one, else the plant's only line for the barcode
    const prod = sap
      ? await client.query(`SELECT id FROM products WHERE barcode = $1 AND (gj_sap = $2 OR mp_sap = $2 OR up_sap = $2) ORDER BY id LIMIT 1`, [ev.barcode, sap])
      : { rows: [] as any[] };
    const line = await findLineForProduct(client, s.plant, ev.barcode, prod.rows[0]?.id ?? null, true);
    if (line) await reverse(line.id, s.plant, s.qty, !!ev.is_extra);
  }
  return out;
}
