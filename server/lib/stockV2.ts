import type { Pool, PoolClient } from 'pg';
import { pool } from '../db';

// Stock Overview core — see server/lib/stockV2Schema.ts for the tables.
//
// One stock line = one item at one plant (name + barcode + the state's SAP code). Every detail on the
// line (name, SAP, Sr No, brand, category ...) is read from the Product Master by barcode when the line is
// made; a CSV / slip / unloading file only ever supplies the barcode. A new arrival for an item that
// already has a line adds to that line — it never makes a second one.
//
// Purchase and Sale are the day-wise figures (extra is INSIDE them; the extra columns only say how much of
// it was extra). Opening and Closing are never stored. The line's stock_qty is the one total Loading draws
// from, kept in step with every posting below.

type Db = Pool | PoolClient;

export type StockV2Line = {
  id: number;
  plant: string;
  state: string | null;
  barcode: string;
  itemName: string;
  sapCode: string | null;
  sapIsFallback: boolean;
  srNo: string | null;
  brand: string | null;
  category: string | null;
  stockQty: number;
};

const LINE_COLS = `id, plant, state, barcode, item_name AS "itemName", sap_code AS "sapCode",
  sap_is_fallback AS "sapIsFallback", sr_no AS "srNo", brand, category, stock_qty AS "stockQty"`;

let plantStateCache: { at: number; map: Map<string, string | null> } | null = null;

export async function stateOfPlant(db: Db, plant: string): Promise<string | null> {
  const now = Date.now();
  if (!plantStateCache || now - plantStateCache.at > 5 * 60_000) {
    const r = await db.query(`SELECT name, state FROM plants`);
    plantStateCache = { at: now, map: new Map(r.rows.map((x: any) => [String(x.name).toLowerCase(), x.state ?? null])) };
  }
  return plantStateCache.map.get(plant.trim().toLowerCase()) ?? null;
}

// The state's own columns on the product, falling back to the generic ones. sapIsFallback is true when the
// state has no SAP of its own and the generic code is used instead.
function detailsFromProduct(p: any, state: string | null) {
  const s = (state || '').toUpperCase();
  const pick = (a: any, b: any) => (a && String(a).trim() ? String(a).trim() : (b && String(b).trim() ? String(b).trim() : null));
  const stateSap = s === 'MP' ? p.mp_sap : s === 'UP' ? p.up_sap : s === 'GJ' ? p.gj_sap : null;
  const stateSr = s === 'MP' ? p.mp_sr : s === 'UP' ? p.up_sr : s === 'GJ' ? p.gj_sr : null;
  const stateHsn = s === 'MP' ? p.mp_hsn : s === 'UP' ? p.up_hsn : s === 'GJ' ? p.gj_hsn : null;
  const ownSap = stateSap && String(stateSap).trim() ? String(stateSap).trim() : null;
  return {
    sapCode: ownSap ?? pick(null, p.sap_code),
    sapIsFallback: !ownSap && !!pick(null, p.sap_code),
    srNo: pick(p.new_sr, stateSr), // the Product Master's New Sr. first (what every other page shows)
    hsn: pick(stateHsn, p.hsn_code),
    pallet: s === 'MP' ? p.mp_plt : s === 'GJ' ? p.gj_plt : null,
  };
}

// A barcode can be shared by more than one Product Master row (e.g. 35 gm and 37 gm packs of the same item), told
// apart only by SAP code. One row -> that row, whatever the SAP. Several rows -> the one whose SAP equals the CSV /
// slip row's SAP: the plant state's own SAP (gj_sap / mp_sap / up_sap) first, then the generic sap_code, then any
// state's. With no SAP given, or none matching, it falls back to the lowest id (the old behaviour) and says so.
const norm = (v: any) => String(v ?? '').trim().toLowerCase();

export async function pickProduct(db: Db, barcode: string, sapCode: string | null | undefined, state: string | null): Promise<any | null> {
  const r = await db.query(`SELECT * FROM products WHERE barcode = $1 ORDER BY id`, [barcode]);
  if (r.rows.length <= 1) return r.rows[0] ?? null;
  const sap = norm(sapCode);
  if (sap) {
    const s = (state || '').toUpperCase();
    const stateCol = s === 'MP' ? 'mp_sap' : s === 'UP' ? 'up_sap' : s === 'GJ' ? 'gj_sap' : null;
    const hit =
      (stateCol && r.rows.find((x: any) => norm(x[stateCol]) === sap)) ||
      r.rows.find((x: any) => norm(x.sap_code) === sap) ||
      r.rows.find((x: any) => ['gj_sap', 'mp_sap', 'up_sap'].some((c) => norm(x[c]) === sap));
    if (hit) return hit;
  }
  console.warn(`[StockV2] barcode ${barcode} matches ${r.rows.length} products and SAP "${sapCode ?? ''}" picked none — using the first`);
  return r.rows[0];
}

// The SAP a CSV / unloading batch / slip row carries for a barcode — only worth knowing when the barcode is shared
// by several products, so it returns null otherwise (leaving single-product barcodes and their links untouched).
async function ambiguousSap(db: Db, barcode: string, lookup: () => Promise<string | null>): Promise<string | null> {
  const c = await db.query(`SELECT COUNT(*)::int AS n FROM products WHERE barcode = $1`, [String(barcode ?? '').trim()]);
  if ((c.rows[0]?.n ?? 0) <= 1) return null;
  return (await lookup()) || null;
}

export const csvSapFor = (db: Db, source: 'order' | 'unload', sessionId: number, barcode: string) =>
  ambiguousSap(db, barcode, async () => {
    const bc = String(barcode).trim();
    if (source === 'unload') {
      const r = await db.query(`SELECT sap_code FROM unload_import_items WHERE session_id = $1 AND LOWER(TRIM(barcode)) = LOWER($2) AND COALESCE(sap_code,'') <> '' LIMIT 1`, [sessionId, bc]);
      return r.rows[0]?.sap_code ?? null;
    }
    const r = await db.query(
      `SELECT sap_code FROM order_scan_items WHERE session_id = $1 AND LOWER(TRIM(barcode)) = LOWER($2) AND COALESCE(sap_code,'') <> '' LIMIT 1`,
      [sessionId, bc],
    );
    if (r.rows[0]?.sap_code) return r.rows[0].sap_code;
    const r2 = await db.query(`SELECT sap_code FROM order_import_items WHERE session_id = $1 AND LOWER(TRIM(barcode)) = LOWER($2) AND COALESCE(sap_code,'') <> '' LIMIT 1`, [sessionId, bc]);
    return r2.rows[0]?.sap_code ?? null;
  });

// Finds the plant's stock line for a barcode, making it from the Product Master when there is none yet.
// Returns null when the barcode is not in the Product Master (the caller decides whether that blocks).
export async function findOrCreateLine(db: Db, plant: string, barcode: string, sapCode?: string | null, productId?: number | null): Promise<StockV2Line | null> {
  const bc = String(barcode ?? '').trim();
  const pl = String(plant ?? '').trim();
  if (!bc || !pl) return null;
  const state = await stateOfPlant(db, pl);
  // A named product (a loading slip line knows which one it is) beats the SAP guess.
  const named = productId != null ? (await db.query(`SELECT * FROM products WHERE id = $1`, [productId])).rows[0] : null;
  const p = named ?? await pickProduct(db, bc, sapCode, state);
  if (!p) return null;
  const d = detailsFromProduct(p, state);
  const existing = await db.query(
    `SELECT ${LINE_COLS} FROM stock_v2_lines
      WHERE LOWER(plant) = LOWER($1) AND LOWER(barcode) = LOWER($2) AND LOWER(item_name) = LOWER($3)
        AND LOWER(COALESCE(sap_code, '')) = LOWER($4)`,
    [pl, bc, p.name, d.sapCode ?? ''],
  );
  if (existing.rows[0]) return existing.rows[0];
  const ins = await db.query(
    `INSERT INTO stock_v2_lines (plant, state, barcode, item_name, sap_code, sap_is_fallback, sr_no, brand, category, hsn_code, pallet_size, product_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT DO NOTHING
     RETURNING ${LINE_COLS}`,
    [pl, state, bc, p.name, d.sapCode, d.sapIsFallback, d.srNo, p.brand ?? null, p.category ?? null, d.hsn, d.pallet ?? null, p.id],
  );
  if (ins.rows[0]) return ins.rows[0];
  // Lost a race with another request — read the line it made.
  const again = await db.query(
    `SELECT ${LINE_COLS} FROM stock_v2_lines
      WHERE LOWER(plant) = LOWER($1) AND LOWER(barcode) = LOWER($2) AND LOWER(item_name) = LOWER($3)
        AND LOWER(COALESCE(sap_code, '')) = LOWER($4)`,
    [pl, bc, p.name, d.sapCode ?? ''],
  );
  return again.rows[0] ?? null;
}

export type DailyDelta = {
  purchase?: number; extraPurchase?: number; sale?: number; extraSale?: number; transferIn?: number; transferOut?: number;
};

// Adds the figures to the line's day and moves stock_qty by the same net. Purchase / transfer in raise the
// stock; sale / transfer out lower it (callers pass positive numbers, or negative ones to take a posting back).
export async function bumpDay(db: Db, lineId: number, date: string, d: DailyDelta): Promise<void> {
  const v = {
    pu: d.purchase ?? 0, xp: d.extraPurchase ?? 0, sa: d.sale ?? 0, xs: d.extraSale ?? 0,
    ti: d.transferIn ?? 0, to: d.transferOut ?? 0,
  };
  if (!v.pu && !v.xp && !v.sa && !v.xs && !v.ti && !v.to) return;
  await db.query(
    `INSERT INTO stock_v2_daily (stock_date, line_id, purchase_qty, extra_purchase_qty, sale_qty, extra_sale_qty, transfer_in_qty, transfer_out_qty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (stock_date, line_id) DO UPDATE SET
       purchase_qty = stock_v2_daily.purchase_qty + EXCLUDED.purchase_qty,
       extra_purchase_qty = stock_v2_daily.extra_purchase_qty + EXCLUDED.extra_purchase_qty,
       sale_qty = stock_v2_daily.sale_qty + EXCLUDED.sale_qty,
       extra_sale_qty = stock_v2_daily.extra_sale_qty + EXCLUDED.extra_sale_qty,
       transfer_in_qty = stock_v2_daily.transfer_in_qty + EXCLUDED.transfer_in_qty,
       transfer_out_qty = stock_v2_daily.transfer_out_qty + EXCLUDED.transfer_out_qty`,
    [date, lineId, v.pu, v.xp, v.sa, v.xs, v.ti, v.to],
  );
  await db.query(
    `UPDATE stock_v2_lines SET stock_qty = stock_qty + $2, updated_at = now() WHERE id = $1`,
    [lineId, v.pu + v.ti - v.sa - v.to],
  );
}

export const postPurchase = (db: Db, lineId: number, date: string, qty: number, extraQty = 0) =>
  bumpDay(db, lineId, date, { purchase: qty, extraPurchase: extraQty });
export const postSale = (db: Db, lineId: number, date: string, qty: number, extraQty = 0) =>
  bumpDay(db, lineId, date, { sale: qty, extraSale: extraQty });

// A correction (Adjust / Opening Stock / Clear Stock): changes the total and is kept as a ledger row, but
// does not touch Purchase or Sale.
export async function postAdjust(
  db: Db,
  lineId: number,
  date: string,
  qty: number,
  info: { kind?: string; source?: string; sourceRef?: number | null; origin?: string | null; reason?: string | null; userCode?: string | null } = {},
): Promise<void> {
  if (!qty) return;
  await db.query(
    `INSERT INTO stock_v2_ledger (line_id, stock_date, kind, qty, source, source_ref, origin, reason, created_by_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [lineId, date, info.kind ?? 'adjust', qty, info.source ?? null, info.sourceRef ?? null, info.origin ?? null, info.reason ?? null, info.userCode ?? null],
  );
  await db.query(`UPDATE stock_v2_lines SET stock_qty = stock_qty + $2, updated_at = now() WHERE id = $1`, [lineId, qty]);
}

// ── Links: a CSV / unloading batch / slip line -> its stock line, made when it becomes active ──

export type LinkKind = 'order_session' | 'unload_session' | 'slip';
export const linkKey = (parts: Array<string | number>) => parts.map((x) => String(x).trim().toLowerCase()).join('|');

export async function getLink(db: Db, kind: LinkKind, refKey: string): Promise<{ lineId: number; purchaseLineId: number | null } | null> {
  const r = await db.query(`SELECT line_id, purchase_line_id FROM stock_v2_links WHERE kind = $1 AND ref_key = $2`, [kind, refKey]);
  return r.rows[0] ? { lineId: r.rows[0].line_id, purchaseLineId: r.rows[0].purchase_line_id } : null;
}

export async function setLink(db: Db, kind: LinkKind, refKey: string, lineId: number, purchaseLineId: number | null = null): Promise<void> {
  await db.query(
    `INSERT INTO stock_v2_links (kind, ref_key, line_id, purchase_line_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (kind, ref_key) DO UPDATE SET line_id = EXCLUDED.line_id, purchase_line_id = EXCLUDED.purchase_line_id`,
    [kind, refKey, lineId, purchaseLineId],
  );
}

// The link for a barcode at a plant: the stored one, or — first time — find/create the line from the
// Product Master and store it. Null when the barcode isn't in the Product Master.
export async function resolveLine(db: Db, kind: LinkKind, refKey: string, plant: string, barcode: string, sapCode?: string | null): Promise<StockV2Line | null> {
  const link = await getLink(db, kind, refKey);
  if (link) {
    const r = await db.query(`SELECT ${LINE_COLS} FROM stock_v2_lines WHERE id = $1`, [link.lineId]);
    if (r.rows[0]) return r.rows[0];
  }
  const line = await findOrCreateLine(db, plant, barcode, sapCode);
  if (line) await setLink(db, kind, refKey, line.id);
  return line;
}

// ── The hooks the operations call ─────────────────────────────────────────────────────────────────────

export const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// The day a receiving CSV / unloading batch belongs to: its Order Date (what the old Stock Overview dates a
// purchase by), or today when it has none.
export async function sessionDay(db: Db, source: 'order' | 'unload', sessionId: number): Promise<string> {
  const table = source === 'unload' ? 'unload_import_sessions' : 'order_import_sessions';
  const r = await db.query(`SELECT order_date FROM ${table} WHERE id = $1`, [sessionId]);
  const d = String(r.rows[0]?.order_date ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayIst();
}

// A purchase (or, negative, a void / correction of one) on the CSV or unloading batch's day. The line comes
// from the CSV's link — made the first time the barcode is seen on that CSV — so later scans don't search.
export async function v2Purchase(
  client: Db,
  p: { source: 'order' | 'unload'; sessionId: number; plant: string; barcode: string; qty: number; extraQty?: number; day?: string | null },
): Promise<void> {
  {
    const db = client;
    if (!p.qty && !p.extraQty) return;
    const sap = await csvSapFor(db, p.source, p.sessionId, p.barcode);
    const line = await resolveLine(db, p.source === 'unload' ? 'unload_session' : 'order_session', linkKey(sap ? [p.sessionId, p.barcode, p.plant, sap] : [p.sessionId, p.barcode, p.plant]), p.plant, p.barcode, sap);
    if (!line) return;
    // An unloading scan carries its own booked day (the day it was scanned); anything without one is dated by the CSV's order date.
    await postPurchase(db, line.id, p.day || await sessionDay(db, p.source, p.sessionId), p.qty, p.extraQty ?? 0);
  }
}

// The plant's stock line for a barcode on a receiving CSV (the line v2Purchase posts to), made when it has none yet.
export async function orderLine(db: Db, sessionId: number, plant: string, barcode: string): Promise<StockV2Line | null> {
  const sap = await csvSapFor(db, 'order', sessionId, barcode);
  return resolveLine(db, 'order_session', linkKey(sap ? [sessionId, barcode, plant, sap] : [sessionId, barcode, plant]), plant, barcode, sap);
}

// The boxes now on that line (locked) - so a void / correction can refuse to take back boxes that were already loaded out.
export async function orderStockLeft(db: Db, sessionId: number, plant: string, barcode: string): Promise<number> {
  const line = await orderLine(db, sessionId, plant, barcode);
  return line ? lockLineStock(db, line.id) : 0;
}

// A transfer between a purchase plant and a stock plant (two-plant Unloading); signed like the purchase.
export async function v2Transfer(
  client: Db,
  p: { sessionId: number; purchasePlant: string; stockPlant: string; barcode: string; qty: number; day?: string | null },
): Promise<void> {
  {
    const db = client;
    if (!p.qty) return;
    const day = p.day || await sessionDay(db, 'unload', p.sessionId);
    const sap = await csvSapFor(db, 'unload', p.sessionId, p.barcode);
    const from = await findOrCreateLine(db, p.purchasePlant, p.barcode, sap);
    const to = await findOrCreateLine(db, p.stockPlant, p.barcode, sap);
    if (!from || !to) return;
    await bumpDay(db, from.id, day, { transferOut: p.qty });
    await bumpDay(db, to.id, day, { transferIn: p.qty });
  }
}

// ── Loading on Stock Overview: one PRODUCT's line at ONE plant ───────────────────────────────────────────────

// The plant's stock line for a product. Two products that share a barcode (35 g / 37 g) are two lines, told apart by the product's SAP code for
// the plant's state, so a load of one never touches the other. With no product given the barcode's only line is used (or the first product's).
// create = false only looks; create = true makes the line (stock 0) when the product has none there yet.
export async function findLineForProduct(db: Db, plant: string, barcode: string, productId?: number | null, create = false): Promise<StockV2Line | null> {
  const bc = String(barcode ?? '').trim();
  const pl = String(plant ?? '').trim();
  if (!bc || !pl) return null;
  if (create) return findOrCreateLine(db, pl, bc, null, productId);
  const state = await stateOfPlant(db, pl);
  const named = productId != null ? (await db.query(`SELECT * FROM products WHERE id = $1`, [productId])).rows[0] : null;
  const p = named ?? await pickProduct(db, bc, null, state);
  if (!p) return null;
  const d = detailsFromProduct(p, state);
  const r = await db.query(
    `SELECT ${LINE_COLS} FROM stock_v2_lines
      WHERE LOWER(plant) = LOWER($1) AND LOWER(barcode) = LOWER($2) AND LOWER(item_name) = LOWER($3) AND LOWER(COALESCE(sap_code, '')) = LOWER($4)`,
    [pl, bc, p.name, d.sapCode ?? ''],
  );
  return r.rows[0] ?? null;
}

// Locks the line's row and returns its Stock, so two loads cannot both take the last boxes.
export async function lockLineStock(db: Db, lineId: number): Promise<number> {
  const r = await db.query(`SELECT stock_qty FROM stock_v2_lines WHERE id = $1 FOR UPDATE`, [lineId]);
  return Number(r.rows[0]?.stock_qty ?? 0);
}

// The day a slip's loading counts on: its order date (India time), else today.
export async function slipDay(db: Db, orderNumber: string): Promise<string> {
  const r = await db.query(`SELECT (order_date AT TIME ZONE 'Asia/Kolkata')::date::text AS day FROM proforma_slips WHERE order_number = $1 ORDER BY id LIMIT 1`, [orderNumber]);
  return r.rows[0]?.day || todayIst();
}

// A sale (positive) or a give-back (negative) on one line, on the slip's day. Extra is inside it (extraQty carries the same sign).
export async function saleOnLine(db: Db, p: { lineId: number; orderNumber: string; qty: number; extraQty?: number }): Promise<void> {
  if (!p.qty) return;
  await postSale(db, p.lineId, await slipDay(db, p.orderNumber), p.qty, p.extraQty ?? 0);
}

// ── Opening stock: only at a fresh start ──────────────────────────────────────────────────────────────

export async function getOpeningState(db: Db): Promise<{ open: boolean; date: string | null }> {
  const r = await db.query(`SELECT opening_open, opening_date::text AS d FROM stock_v2_config WHERE id = 1`);
  return { open: !!r.rows[0]?.opening_open, date: r.rows[0]?.d ?? null };
}

// Clears Stock Overview (days, corrections, totals) and opens the opening window dated `date`.
export async function startFresh(date: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM stock_v2_daily`);
    await client.query(`DELETE FROM stock_v2_ledger`);
    await client.query(`UPDATE stock_v2_lines SET stock_qty = 0, updated_at = now()`);
    await client.query(`UPDATE stock_v2_config SET opening_open = true, opening_date = $1 WHERE id = 1`, [date]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

// Sets one line's opening figure (replacing an earlier opening entry for it, never adding twice).
export async function setOpening(db: Db, plant: string, barcode: string, qty: number, date: string, userCode: string | null): Promise<StockV2Line | null> {
  const line = await findOrCreateLine(db, plant, barcode);
  if (!line) return null;
  const prev = await db.query(`SELECT COALESCE(SUM(qty),0)::int AS q FROM stock_v2_ledger WHERE line_id = $1 AND kind = 'opening'`, [line.id]);
  await db.query(`DELETE FROM stock_v2_ledger WHERE line_id = $1 AND kind = 'opening'`, [line.id]);
  await db.query(`UPDATE stock_v2_lines SET stock_qty = stock_qty - $2, updated_at = now() WHERE id = $1`, [line.id, prev.rows[0].q]);
  await postAdjust(db, line.id, date, qty, { kind: 'opening', source: 'opening', origin: 'opening', reason: 'Opening stock (fresh start)', userCode });
  return line;
}

// A correction (manual Adjust, Clear Stock, Exchange, the Settings opening import): changes the line's total
// and is kept as a ledger row; Purchase and Sale are not touched. `date` defaults to today.
export async function v2Adjust(
  client: Db,
  p: { plant: string; barcode: string; qty: number; kind: 'adjust' | 'clear' | 'exchange' | 'opening'; reason?: string | null; userCode?: string | null; date?: string | null; productId?: number | null },
): Promise<void> {
  if (!p.qty) return;
  // The named product's line (twins sharing a barcode are separate lines); without one, the barcode's usual line.
  const line = await findOrCreateLine(client, p.plant, p.barcode, null, p.productId ?? null);
  if (!line) throw new Error(`"${p.barcode}" is not in the Product Master.`);
  await postAdjust(client, line.id, (p.date ? String(p.date).slice(0, 10) : '') || todayIst(), p.qty, { kind: p.kind, source: p.kind, origin: p.kind, reason: p.reason ?? null, userCode: p.userCode ?? null });
}

// Before an edit moves already-received boxes from one barcode to another: null when it can go ahead, else the
// reason it is refused — the new barcode is not in the Product Master, or the boxes on the old line have
// already been used (loaded / adjusted away), so there is nothing left to move.
export async function v2MoveRefusal(db: Db, plant: string, oldBarcode: string, newBarcode: string, qty: number): Promise<string | null> {
  try {
    const np = await db.query(`SELECT 1 FROM products WHERE barcode = $1 LIMIT 1`, [String(newBarcode).trim()]);
    if (!np.rows[0]) return `Barcode ${newBarcode} is not in the Product Master — add it there first, then edit this row.`;
    const old = await findOrCreateLine(db, plant, oldBarcode);
    if (old && old.stockQty < qty) {
      return `Cannot move ${qty} boxes off ${oldBarcode}: only ${old.stockQty} are left at ${plant} — the rest were already used.`;
    }
    return null;
  } catch (e) {
    console.error('[StockV2] move check failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

// A product's barcode was edited (a Product Master edit, the Notion sync): its stock lines follow it, so the stock stays with the product. When the
// product already has a line under the new barcode at that plant (same name and SAP), the two are merged: days, corrections and links move over and
// Stock adds up.
export async function renameLinesBarcode(db: Db, productId: number, newBarcode: string): Promise<number> {
  const bc = String(newBarcode ?? '').trim();
  if (!bc) return 0;
  const { rows } = await db.query(`SELECT id, plant, item_name, sap_code, stock_qty FROM stock_v2_lines WHERE product_id = $1 AND LOWER(barcode) <> LOWER($2)`, [productId, bc]);
  for (const l of rows) {
    const t = await db.query(
      `SELECT id FROM stock_v2_lines WHERE LOWER(plant) = LOWER($1) AND LOWER(barcode) = LOWER($2) AND LOWER(item_name) = LOWER($3) AND LOWER(COALESCE(sap_code, '')) = LOWER($4)`,
      [l.plant, bc, l.item_name, l.sap_code ?? ''],
    );
    if (!t.rows[0]) {
      await db.query(`UPDATE stock_v2_lines SET barcode = $2, updated_at = now() WHERE id = $1`, [l.id, bc]);
      continue;
    }
    const to = t.rows[0].id;
    await db.query(
      `INSERT INTO stock_v2_daily (stock_date, line_id, purchase_qty, extra_purchase_qty, sale_qty, extra_sale_qty, transfer_in_qty, transfer_out_qty)
       SELECT stock_date, $2, purchase_qty, extra_purchase_qty, sale_qty, extra_sale_qty, transfer_in_qty, transfer_out_qty FROM stock_v2_daily WHERE line_id = $1
       ON CONFLICT (stock_date, line_id) DO UPDATE SET
         purchase_qty = stock_v2_daily.purchase_qty + EXCLUDED.purchase_qty, extra_purchase_qty = stock_v2_daily.extra_purchase_qty + EXCLUDED.extra_purchase_qty,
         sale_qty = stock_v2_daily.sale_qty + EXCLUDED.sale_qty, extra_sale_qty = stock_v2_daily.extra_sale_qty + EXCLUDED.extra_sale_qty,
         transfer_in_qty = stock_v2_daily.transfer_in_qty + EXCLUDED.transfer_in_qty, transfer_out_qty = stock_v2_daily.transfer_out_qty + EXCLUDED.transfer_out_qty`,
      [l.id, to],
    );
    await db.query(`UPDATE stock_v2_ledger SET line_id = $2 WHERE line_id = $1`, [l.id, to]);
    await db.query(`UPDATE stock_v2_links SET line_id = $2 WHERE line_id = $1 AND NOT EXISTS (SELECT 1 FROM stock_v2_links k WHERE k.kind = stock_v2_links.kind AND k.ref_key = stock_v2_links.ref_key AND k.line_id = $2)`, [l.id, to]);
    await db.query(`UPDATE stock_v2_links SET purchase_line_id = $2 WHERE purchase_line_id = $1`, [l.id, to]);
    await db.query(`UPDATE stock_v2_lines SET stock_qty = stock_qty + $2, updated_at = now() WHERE id = $1`, [to, l.stock_qty]);
    await db.query(`UPDATE loading_scan_events SET stock_line_id = $2 WHERE stock_line_id = $1`, [l.id, to]);
    await db.query(`DELETE FROM stock_v2_lines WHERE id = $1`, [l.id]);
  }
  return rows.length;
}
