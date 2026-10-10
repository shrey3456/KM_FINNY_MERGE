import { Router, Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';
import { ensureLoadingSalesTables } from '../lib/loadingSalesSchema';
import { ensureManualSalesTables } from '../lib/manualSalesSchema';
import { getPooledStock, getStatePlantNames, debitStatePool, recordStockPulls, reverseStockPullsForEvent, type StockPullContribution } from '../lib/statePool';
import { reconcileProductPlantStockBarcode } from '../lib/stockBarcodeReconcile';
import { getPlantStateCode, resolvePalletSizeOrQty } from './order-scan';
import { reclassifyLoadingEvents } from './loading';
import { reverseManualSaleBatch } from './manual-sales';

// Settings > Data Management > "Load from Sales Orders file". The file lists, per ORDER NUMBER, the items and quantities that
// were really loaded (Date, Order Number, Party, Name of Item "SAP (name)", Balance Quantity). For each order the system finds
// its proforma slip and records the loading the way a real scan would: loading_scan_events (a regular row up to what the slip
// asks, an Extra row for anything beyond it), the per-plant stock pulls (stock comes off the slip plant's whole state pool,
// own plant first), and the stock ledger lines — so Load Master, Stock Overview's Sale and the slip pages all show it.
//
// What it deliberately does NOT do: change a slip's status, mark it complete, or send anything to Notion. Stock never goes
// below zero — an item the pool cannot cover loads what there is. The file is the day's TOTAL for each order + item, so boxes
// already loaded on the slip are counted first and only the difference is added (uploading the same file twice adds nothing).
// Everything is one batch that can be reversed. Entries are stamped at 12:00 on the slip's order date (the app stores local time).
const router = Router();
router.use('/loading-sales', async (_req, res, next) => {
  try { await ensureLoadingSalesTables(); await ensureManualSalesTables(); next(); }
  catch (e) { console.error('[Loading from sales file] tables unavailable:', e); res.status(500).json({ message: 'This tool is not available — its tables could not be created.' }); }
});

type Db = Pool | PoolClient;
const actor = (req: Request) => { const u = req.user as any; return { userCode: u?.userCode as string | undefined, userName: (u?.name || u?.username || u?.userCode) as string | undefined }; };
const norm = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const low = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();

// `barcode` is set when the line was already matched to a product (the Proforma Slips page's Create System Generated Load Slip preview
// does that, including the person's own link / skip picks); without it the line is matched here by SAP code (per the plant's state) and name.
type FileLine = { orderNumber?: string; sapCode?: string | null; itemName?: string | null; quantity?: number; party?: string | null; barcode?: string | null; fileDate?: string | null };
type SlipRow = { id: number; order_number: string; plant: string | null; order_date: string; vehicle_number: string | null; party_name: string | null; done: boolean; loading_stv: string | null };
type SlipItem = { id: number; barcode: string; item_name: string | null; sap_code: string | null; quantity: number };
type PlanItem = {
  slip: SlipRow; item: SlipItem; target: number; already: number; toAdd: number; sell: number; available: number;
  regular: number; extra: number; status: 'ok' | 'partial' | 'short' | 'already'; names: string[];
};
type Problem = { orderNumber: string; party: string | null; sapCode: string | null; itemName: string | null; quantity: number; reason: string };
type OrderResult = {
  orderNumber: string; party: string | null; plant: string | null; vehicle: string | null; orderDate: string | null; fileDate: string | null;
  found: boolean; completed: boolean; lines: number; items: number; requested: number; boxes: number; alreadyLoaded: number;
  partial: number; short: number; unmatched: number;
};

export async function evaluateLoading(db: Db, inLines: FileLine[]) {
  // 1) the file, per order (an order with the same item on two lines adds up)
  const lines = inLines
    .map((l) => ({ barcode: String(l.barcode ?? '').trim() || null, orderNumber: String(l.orderNumber ?? '').trim(), sapCode: String(l.sapCode ?? '').trim() || null, itemName: String(l.itemName ?? '').trim() || null, quantity: Math.round(Number(l.quantity) || 0), party: String(l.party ?? '').trim() || null, fileDate: String(l.fileDate ?? '').trim() || null }))
    .filter((l) => l.orderNumber && l.quantity > 0);
  const byOrder = new Map<string, typeof lines>();
  for (const l of lines) { if (!byOrder.has(l.orderNumber)) byOrder.set(l.orderNumber, []); byOrder.get(l.orderNumber)!.push(l); }
  const orderNumbers = [...byOrder.keys()].sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));

  // 2) their slips, slip items, and what is already loaded
  const { rows: slipRows } = await db.query(
    `SELECT id, order_number, plant, order_date::text AS order_date, vehicle_number, party_name, (loading_completed_at IS NOT NULL) AS done, loading_stv
       FROM proforma_slips WHERE order_number = ANY($1::text[])`, [orderNumbers]);
  const slipByOrder = new Map<string, SlipRow>(slipRows.map((s: any) => [s.order_number, s]));
  const slipIds = slipRows.map((s: any) => s.id);
  const { rows: itemRows } = await db.query(
    `SELECT id, proforma_slip_id, TRIM(barcode) AS barcode, item_name, sap_code, quantity FROM proforma_slip_items WHERE proforma_slip_id = ANY($1::int[]) AND barcode IS NOT NULL`, [slipIds]);
  const itemsBySlip = new Map<number, SlipItem[]>();
  for (const r of itemRows as any[]) { if (!itemsBySlip.has(r.proforma_slip_id)) itemsBySlip.set(r.proforma_slip_id, []); itemsBySlip.get(r.proforma_slip_id)!.push({ id: r.id, barcode: r.barcode, item_name: r.item_name, sap_code: r.sap_code, quantity: Number(r.quantity ?? 0) }); }
  const { rows: loadedRows } = await db.query(
    `SELECT order_number, LOWER(TRIM(barcode)) AS bc, COALESCE(SUM(total_qty),0)::int AS q FROM loading_scan_events
      WHERE voided IS NOT TRUE AND order_number = ANY($1::text[]) GROUP BY 1,2`, [orderNumbers]);
  const loaded = new Map<string, number>(loadedRows.map((r: any) => [`${r.order_number}|${r.bc}`, Number(r.q)]));

  // 3) the Product Master, used to read each file line's item (SAP code and name) the way the rest of the app does
  const { rows: prods } = await db.query(`SELECT id, TRIM(barcode) AS barcode, name, gj_sap, mp_sap, sap_code FROM products WHERE barcode IS NOT NULL`);
  const byBarcode = new Map<string, any>(); const byName = new Map<string, any[]>();
  for (const p of prods as any[]) {
    byBarcode.set(low(p.barcode), p);
    const nk = norm(p.name); if (nk) { if (!byName.has(nk)) byName.set(nk, []); byName.get(nk)!.push(p); }
  }
  // SAP lookup for one plant's state, as the Create System Generated Load Slip preview does: GJ plants read the GJ SAP column, others the MP column, sap_code as the fallback.
  const sapMaps = new Map<string, Map<string, any[]>>();
  const sapMapFor = async (plant: string) => {
    const state = await getPlantStateCode(db, plant);
    const key = state ?? '';
    if (!sapMaps.has(key)) {
      const cols = state === 'GJ' ? ['gj_sap', 'sap_code'] : ['mp_sap', 'sap_code'];
      const m = new Map<string, any[]>();
      for (const p of prods as any[]) for (const c of cols) { const k = String(p[c] ?? '').trim(); if (!k) continue; const list = m.get(k) ?? []; if (!list.includes(p)) list.push(p); m.set(k, list); }
      sapMaps.set(key, m);
    }
    return sapMaps.get(key)!;
  };
  let synthetic = 0;
  // The file line's product, then the slip's line for it. A product that is not on the slip is loaded as Extra (a synthetic line with slip quantity 0).
  const matchSlipItem = (l: { sapCode: string | null; itemName: string | null; barcode: string | null }, items: SlipItem[], sapMap: Map<string, any[]>): { item: SlipItem } | { problem: string } => {
    const nameN = norm(l.itemName);
    let product: any = null;
    if (l.barcode) { product = byBarcode.get(low(l.barcode)) ?? null; if (!product) return { problem: `Barcode ${l.barcode} is not in the Product Master` }; }
    else {
      let cand = l.sapCode ? (sapMap.get(l.sapCode) ?? []) : [];
      if (cand.length > 1 && nameN) { const byN = cand.filter((p) => norm(p.name) === nameN); if (byN.length) cand = byN; }
      if (cand.length > 1) { const onSlip = cand.filter((p) => items.some((i) => low(i.barcode) === low(p.barcode))); if (onSlip.length) cand = onSlip; }
      if (cand.length === 0 && nameN) cand = byName.get(nameN) ?? [];
      if (cand.length > 1) { const onSlip = cand.filter((p) => items.some((i) => low(i.barcode) === low(p.barcode))); if (onSlip.length === 1) cand = onSlip; }
      if (cand.length === 1) product = cand[0];
      else if (cand.length > 1) return { problem: 'More than one product matches this SAP code / name' };
    }
    if (product) {
      const onSlip = items.find((i) => low(i.barcode) === low(product.barcode));
      if (onSlip) return { item: onSlip };
      return { item: { id: -(++synthetic), barcode: String(product.barcode).trim(), item_name: product.name ?? l.itemName, sap_code: l.sapCode, quantity: 0 } };
    }
    // not found in the Product Master — read it off the slip's own lines
    let m = items.filter((i) => l.sapCode && String(i.sap_code ?? '').trim() === l.sapCode && nameN && norm(i.item_name) === nameN);
    if (!m.length && nameN) m = items.filter((i) => norm(i.item_name) === nameN);
    if (!m.length && l.sapCode) { const bySapOnly = items.filter((i) => String(i.sap_code ?? '').trim() === l.sapCode); if (bySapOnly.length === 1) m = bySapOnly; }
    return m[0] ? { item: m[0] } : { problem: 'No SAP code / name match in the Product Master or on this slip' };
  };

  // 4) stock: the slip plant's whole state pool, boxes already promised to an earlier line of this file are not offered again
  const promised = new Map<string, number>(); const stateKeyOf = new Map<string, string>();
  const poolKey = async (plant: string, barcode: string) => {
    let sk = stateKeyOf.get(plant);
    if (!sk) { sk = (await getStatePlantNames(db, plant)).map((n) => n.toLowerCase()).sort().join(','); stateKeyOf.set(plant, sk); }
    return `${sk}|${low(barcode)}`;
  };

  const plan: PlanItem[] = []; const problems: Problem[] = []; const orders: OrderResult[] = [];
  for (const orderNumber of orderNumbers) {
    const fl = byOrder.get(orderNumber)!;
    const party = fl.find((x) => x.party)?.party ?? null;
    const slip = slipByOrder.get(orderNumber);
    const base: OrderResult = { orderNumber, party, fileDate: fl.find((x) => x.fileDate)?.fileDate ?? null, plant: slip?.plant ?? null, vehicle: slip?.vehicle_number ?? null, orderDate: slip?.order_date ?? null, found: !!slip, completed: !!slip?.done, lines: fl.length, items: 0, requested: 0, boxes: 0, alreadyLoaded: 0, partial: 0, short: 0, unmatched: 0 };
    if (!slip) { fl.forEach((l) => problems.push({ orderNumber, party, sapCode: l.sapCode, itemName: l.itemName, quantity: l.quantity, reason: 'No proforma slip with this order number' })); base.unmatched = fl.length; orders.push(base); continue; }
    if (slip.done) { orders.push(base); continue; }
    if (!slip.plant) { fl.forEach((l) => problems.push({ orderNumber, party, sapCode: l.sapCode, itemName: l.itemName, quantity: l.quantity, reason: 'The slip has no plant' })); base.unmatched = fl.length; orders.push(base); continue; }
    const items = itemsBySlip.get(slip.id) ?? [];
    const groups = new Map<string, { item: SlipItem; target: number; names: string[] }>();
    const sapMap = await sapMapFor(slip.plant);
    for (const l of fl) {
      const hit = matchSlipItem(l, items, sapMap);
      if ('problem' in hit) { problems.push({ orderNumber, party, sapCode: l.sapCode, itemName: l.itemName, quantity: l.quantity, reason: hit.problem }); base.unmatched++; continue; }
      const item = hit.item;
      if (!byBarcode.has(low(item.barcode))) { problems.push({ orderNumber, party, sapCode: l.sapCode, itemName: l.itemName, quantity: l.quantity, reason: `Barcode ${item.barcode} is not in the Product Master` }); base.unmatched++; continue; }
      const gk = low(item.barcode);
      const g = groups.get(gk) ?? { item, target: 0, names: [] }; g.target += l.quantity; if (l.itemName) g.names.push(l.itemName); groups.set(gk, g);
    }
    for (const g of groups.values()) {
      const already = loaded.get(`${orderNumber}|${low(g.item.barcode)}`) ?? 0;
      const toAdd = Math.max(0, g.target - already);
      base.items++; base.requested += toAdd; base.alreadyLoaded += Math.min(already, g.target);
      if (toAdd === 0) { plan.push({ slip, item: g.item, target: g.target, already, toAdd: 0, sell: 0, available: 0, regular: 0, extra: 0, status: 'already', names: g.names }); continue; }
      const pk = await poolKey(slip.plant, g.item.barcode);
      const pooled = await getPooledStock(db, g.item.barcode, slip.plant);
      const available = Math.max(0, pooled.total - (promised.get(pk) ?? 0));
      const sell = Math.min(toAdd, available);
      if (sell > 0) promised.set(pk, (promised.get(pk) ?? 0) + sell);
      const regularRoom = Math.max(0, g.item.quantity - already);
      const regular = Math.min(sell, regularRoom);
      const status = sell === 0 ? 'short' : sell < toAdd ? 'partial' : 'ok';
      if (status === 'short') base.short++; else if (status === 'partial') base.partial++;
      base.boxes += sell;
      plan.push({ slip, item: g.item, target: g.target, already, toAdd, sell, available, regular, extra: sell - regular, status, names: g.names });
    }
    orders.push(base);
  }
  return { orders, problems, plan };
}

const summarise = (r: Awaited<ReturnType<typeof evaluateLoading>>) => {
  const rows = r.plan;
  return {
    orders: r.orders.length,
    ordersFound: r.orders.filter((o) => o.found).length,
    ordersMissing: r.orders.filter((o) => !o.found).length,
    ordersComplete: r.orders.filter((o) => o.completed).length,
    ordersWithoutVehicle: r.orders.filter((o) => o.found && !o.completed && !o.vehicle).length,
    itemLines: rows.length,
    boxes: rows.reduce((s, p) => s + p.sell, 0),
    requested: rows.reduce((s, p) => s + p.toAdd, 0),
    extraBoxes: rows.reduce((s, p) => s + p.extra, 0),
    alreadyCovered: rows.filter((p) => p.status === 'already').length,
    partial: rows.filter((p) => p.status === 'partial').length,
    short: rows.filter((p) => p.status === 'short').length,
    unmatched: r.problems.length,
  };
};

// The manual sales (Settings > Manual Sales) already on the days these slips belong to — the same sale counted a second time if
// both stay, so the person is asked to reverse them first.
async function manualSalesOnDates(db: Db, dates: string[]) {
  if (dates.length === 0) return [];
  const { rows } = await db.query(
    `SELECT id, sale_date::text AS "saleDate", plant, csv_file_name AS "csvFileName", total_qty AS "totalQty" FROM manual_sale_batches
      WHERE status = 'active' AND sale_date = ANY($1::date[]) ORDER BY id`, [dates]);
  return rows as { id: number; saleDate: string; plant: string; csvFileName: string | null; totalQty: number }[];
}

// The slips' days, read once, to find the manual sales on them.
async function datesOf(db: Db, lines: FileLine[]): Promise<string[]> {
  const orderNumbers = [...new Set(lines.map((l) => String(l.orderNumber ?? '').trim()).filter(Boolean))];
  const { rows } = await db.query(`SELECT DISTINCT order_date::text AS d FROM proforma_slips WHERE order_number = ANY($1::text[])`, [orderNumbers]);
  return rows.map((r: any) => r.d);
}

// POST /api/loading-sales/preview — body { lines:[{orderNumber, sapCode, itemName, quantity, party}], reverseManualSales }
// Everything is worked out inside a transaction that is rolled back, so nothing is changed.
router.post('/loading-sales/preview', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const lines: FileLine[] = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (lines.length === 0) return res.status(400).json({ message: 'The file has no lines' });
    const reverseManual = req.body?.reverseManualSales === true;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const dates = await datesOf(client, lines);
      const manual = await manualSalesOnDates(client, dates);
      if (reverseManual) for (const m of manual) await reverseManualSaleBatch(client, m.id, null);
      const r = await evaluateLoading(client, lines);
      await client.query('ROLLBACK');
      res.json({
        summary: summarise(r), orders: r.orders, problems: r.problems.slice(0, 400), problemsTotal: r.problems.length,
        shortLines: r.plan.filter((p) => p.status === 'short' || p.status === 'partial').slice(0, 1000).map((p) => ({
          orderNumber: p.slip.order_number, party: p.slip.party_name, plant: p.slip.plant, orderDate: p.slip.order_date,
          itemName: p.item.item_name, sapCode: p.item.sap_code, barcode: p.item.barcode,
          fileQty: p.target, alreadyLoaded: p.already, requested: p.toAdd, loads: p.sell, stock: p.available, noStock: p.status === 'short',
        })),
        manualSales: manual, manualSalesReversed: reverseManual, dates,
      });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  } catch (error) {
    console.error('Error previewing loading from sales file:', error);
    res.status(500).json({ message: 'Failed to check the file' });
  }
});

// POST /api/loading-sales/apply — body { lines, csvFileName, reverseManualSales }
router.post('/loading-sales/apply', requireAdminRole, async (req: Request, res: Response) => {
  const lines: FileLine[] = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (lines.length === 0) return res.status(400).json({ message: 'The file has no lines' });
  const csvFileName = String(req.body?.csvFileName ?? '').trim() || null;
  const reverseManual = req.body?.reverseManualSales === true;
  const { userCode, userName } = actor(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dates = await datesOf(client, lines);
    const manual = await manualSalesOnDates(client, dates);
    if (manual.length > 0 && !reverseManual) {
      await client.query('ROLLBACK');
      return res.status(409).json({ manualSales: manual, message: `${manual.length} manual sale batch(es) already exist for ${dates.join(', ')} — loading this file too would count the same sales twice. Reverse them first.` });
    }
    for (const m of manual) await reverseManualSaleBatch(client, m.id, userCode ?? null);

    const r = await evaluateLoading(client, lines);
    const toWrite = r.plan.filter((p) => p.sell > 0);
    if (toWrite.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Nothing to load — every line is already loaded, short of stock or not matched.', summary: summarise(r) }); }

    const saleDate = [...new Set(toWrite.map((p) => p.slip.order_date))].sort()[0] ?? null;
    const { rows: batchRows } = await client.query(
      `INSERT INTO loading_sales_batches (sale_date, csv_file_name, order_count, event_count, total_qty, note, created_by_code, created_by_name)
       VALUES ($1::date, $2, $3, 0, 0, $4, $5, $6) RETURNING id`,
      [saleDate, csvFileName, new Set(toWrite.map((p) => p.slip.order_number)).size, manual.length ? `Replaced manual sale batch(es) ${manual.map((m) => '#' + m.id).join(', ')}` : null, userCode ?? null, userName ?? null]);
    const batchId: number = batchRows[0].id;

    let events = 0, boxes = 0;
    for (const p of toWrite) {
      const barcode = p.item.barcode;
      const slip = p.slip;
      const product = await storage.getProductByBarcode(barcode, slip.plant);
      const state = await getPlantStateCode(client, slip.plant ?? '');
      const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, p.item.quantity);
      const contributions = await debitStatePool(client, barcode, slip.plant ?? '', p.sell, product?.id);

      // the same regular / extra slicing a real scan does, so each event's pulls add up to exactly its own quantity
      let sliceRemaining = p.regular;
      const regularContributions: StockPullContribution[] = []; const extraContributions: StockPullContribution[] = [];
      for (const c of contributions) {
        if (sliceRemaining <= 0) { extraContributions.push(c); continue; }
        if (c.qty <= sliceRemaining) { regularContributions.push(c); sliceRemaining -= c.qty; }
        else { regularContributions.push({ plant: c.plant, qty: sliceRemaining }); extraContributions.push({ plant: c.plant, qty: c.qty - sliceRemaining }); sliceRemaining = 0; }
      }
      const insertEvent = async (qty: number, isExtra: boolean): Promise<number> => {
        const { rows } = await client.query(
          `INSERT INTO loading_scan_events
             (order_number, proforma_slip_id, barcode, item_name, sap_code, pallets, loose_qty, total_qty, is_extra, plant, stv, scanned_by_code, scanned_by_name, scanned_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamp) RETURNING id`,
          [
            slip.order_number, slip.id, barcode, p.item.item_name ?? product?.name ?? null, p.item.sap_code ?? product?.sapCode ?? null,
            itemsPerPallet > 0 ? Math.floor(qty / itemsPerPallet) : 0, itemsPerPallet > 0 ? qty % itemsPerPallet : qty, qty, isExtra,
            slip.plant, slip.loading_stv, userCode ?? null, `${userName ?? userCode ?? 'Admin'} (sales file)`, `${slip.order_date} 12:00:00`,
          ]);
        return rows[0].id as number;
      };
      if (p.regular > 0) { const id = await insertEvent(p.regular, false); await recordStockPulls(client, id, regularContributions); await client.query(`INSERT INTO loading_sales_batch_events (batch_id, event_id, order_number) VALUES ($1,$2,$3)`, [batchId, id, slip.order_number]); events++; }
      if (p.extra > 0) { const id = await insertEvent(p.extra, true); await recordStockPulls(client, id, extraContributions); await client.query(`INSERT INTO loading_sales_batch_events (batch_id, event_id, order_number) VALUES ($1,$2,$3)`, [batchId, id, slip.order_number]); events++; }

      const extraByPlant = new Map<string, number>();
      for (const c of extraContributions) extraByPlant.set(c.plant, (extraByPlant.get(c.plant) ?? 0) + c.qty);
      for (const c of contributions) {
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
           VALUES ($1,$2,$3,$4,$5,'dispatch',$6,$7,'loading')`,
          [barcode, product?.id ?? null, c.plant, -c.qty, extraByPlant.get(c.plant) ?? 0,
            (c.plant === slip.plant ? `Loaded for order ${slip.order_number}` : `Loaded for order ${slip.order_number} (pooled from ${c.plant} for ${slip.plant})`) + ' — from sales file', userCode ?? null]);
      }
      boxes += p.sell;
    }
    // The Loading page lists loading_records rows, so an order that never had a load operation gets one (no vehicle needed) — otherwise
    // its entries would show in Stock Overview and Scan History but not in the Loading list. The slip itself is not touched.
    const createdRecordIds: number[] = [];
    const seenSlips = new Set<number>();
    for (const p of toWrite) {
      if (seenSlips.has(p.slip.id)) continue; seenSlips.add(p.slip.id);
      const { rows: have } = await client.query(`SELECT 1 FROM loading_records WHERE order_number = $1 LIMIT 1`, [p.slip.order_number]);
      if (have[0]) continue;
      const { rows: ins } = await client.query(
        `INSERT INTO loading_records (order_number, proforma_slip_id, party_name, plant, vehicle_number, created_by_code, created_by_name, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamp) RETURNING id`,
        [p.slip.order_number, p.slip.id, p.slip.party_name, p.slip.plant, p.slip.vehicle_number ?? '', userCode ?? null, `${userName ?? userCode ?? 'Admin'} (sales file)`, `${p.slip.order_date} 12:00:00`]);
      createdRecordIds.push(ins[0].id);
    }
    await client.query(`UPDATE loading_sales_batches SET event_count = $2, total_qty = $3, created_record_ids = $4 WHERE id = $1`, [batchId, events, boxes, createdRecordIds]);
    await client.query(
      `UPDATE products pr SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(pps.barcode) = LOWER(pr.barcode)), 0)
        WHERE LOWER(pr.barcode) IN (SELECT LOWER(TRIM(x)) FROM unnest($1::text[]) AS x)`, [toWrite.map((p) => p.item.barcode)]);
    await client.query('COMMIT');

    try {
      await storage.logActivity({
        pageName: 'Settings', action: 'create', entityType: 'loading_sales_batch', entityId: String(batchId),
        details: `Loading created from sales file ${csvFileName ?? ''}: ${new Set(toWrite.map((p) => p.slip.order_number)).size} order(s), ${events} entr${events === 1 ? 'y' : 'ies'}, ${boxes} boxes${manual.length ? `; manual sale batch(es) ${manual.map((m) => '#' + m.id).join(', ')} reversed first` : ''}.`,
        userCode, userName,
      });
    } catch { /* the loading matters more than its log line */ }
    res.json({ success: true, batchId, ordersLoaded: new Set(toWrite.map((p) => p.slip.order_number)).size, events, boxes, summary: summarise(r), manualReversed: manual.length });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error creating loading from sales file:', error);
    res.status(error?.status ?? 500).json({ message: error?.message || 'Failed — nothing was changed.' });
  } finally { client.release(); }
});

router.get('/loading-sales/batches', requireAdminRole, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, sale_date::text AS "saleDate", csv_file_name AS "csvFileName", order_count AS "orderCount", event_count AS "eventCount", total_qty AS "totalQty",
              note, status, created_by_name AS "createdByName", created_at AS "createdAt" FROM loading_sales_batches ORDER BY id DESC LIMIT 50`);
    res.json({ batches: rows });
  } catch (error) { console.error('Error listing loading sales batches:', error); res.status(500).json({ message: 'Failed to load the batches' }); }
});

// POST /api/loading-sales/batches/:id/reverse — voids every entry of the batch exactly like voiding a load scan: the boxes go
// back to the plants they came from, a ledger line explains it, and the rows stay (voided) in the history.
router.post('/loading-sales/batches/:id/reverse', requireAdminRole, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Bad batch id' });
  const { userCode, userName } = actor(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: b } = await client.query(`SELECT * FROM loading_sales_batches WHERE id = $1 FOR UPDATE`, [id]);
    if (!b[0]) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Batch not found' }); }
    if (b[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ message: 'This batch was already reversed.' }); }
    const { rows: ev } = await client.query(`SELECT e.* FROM loading_sales_batch_events be JOIN loading_scan_events e ON e.id = be.event_id WHERE be.batch_id = $1 ORDER BY e.id FOR UPDATE OF e`, [id]);
    const touched = new Set<string>();
    for (const event of ev) {
      if (event.voided) continue;
      const qty = Number(event.total_qty ?? 0);
      if (qty > 0 && event.plant && event.barcode) {
        const product = await storage.getProductByBarcode(event.barcode, event.plant);
        let contributions = await reverseStockPullsForEvent(client, event.id, event.barcode);
        if (contributions.length === 0) {
          await reconcileProductPlantStockBarcode(client, product?.id, event.plant, event.barcode);
          await client.query(`UPDATE product_plant_stock SET in_stock = in_stock + $1, updated_at = NOW() WHERE barcode = $2 AND LOWER(TRIM(plant)) = LOWER(TRIM($3))`, [qty, event.barcode, event.plant]);
          contributions = [{ plant: event.plant, qty }];
        }
        for (const c of contributions) {
          await client.query(
            `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
             VALUES ($1,$2,$3,$4,0,'adjust',$5,$6,'loading')`,
            [event.barcode, product?.id ?? null, c.plant, c.qty, `Voided load scan for order ${event.order_number} (sales-file batch #${id} reversed)`, userCode ?? null]);
        }
      }
      await client.query(`UPDATE loading_scan_events SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2 WHERE id = $3`, [userCode ?? null, `Sales-file loading batch #${id} reversed`, event.id]);
      touched.add(`${event.order_number}|${event.barcode}`);
    }
    // a surviving Extra on the same order + item may now belong in the regular slot this freed up
    for (const key of touched) {
      const [orderNumber, barcode] = key.split('|');
      const { rows } = await client.query(`SELECT psi.quantity FROM proforma_slip_items psi JOIN proforma_slips ps ON ps.id = psi.proforma_slip_id WHERE ps.order_number = $1 AND LOWER(TRIM(psi.barcode)) = LOWER(TRIM($2)) LIMIT 1`, [orderNumber, barcode]);
      if (rows[0]) await reclassifyLoadingEvents(client, orderNumber, barcode, Number(rows[0].quantity ?? 0));
    }
    await client.query(
      `UPDATE products pr SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(pps.barcode) = LOWER(pr.barcode)), 0)
        WHERE LOWER(pr.barcode) IN (SELECT LOWER(TRIM(x)) FROM unnest($1::text[]) AS x)`, [[...touched].map((k) => k.split('|')[1])]);
    // the Loading-list rows this batch created go with it (only if the order has no other live entries)
    for (const rid of (b[0].created_record_ids ?? []) as number[]) {
      await client.query(`DELETE FROM loading_records lr WHERE lr.id = $1 AND NOT EXISTS (SELECT 1 FROM loading_scan_events e WHERE e.order_number = lr.order_number AND e.voided IS NOT TRUE)`, [rid]);
    }
    await client.query(`UPDATE loading_sales_batches SET status = 'reversed', reversed_at = NOW(), reversed_by_code = $2 WHERE id = $1`, [id, userCode ?? null]);
    await client.query('COMMIT');
    try { await storage.logActivity({ pageName: 'Settings', action: 'delete', entityType: 'loading_sales_batch', entityId: String(id), details: `Loading batch #${id} (${b[0].csv_file_name ?? 'sales file'}, ${b[0].total_qty} boxes) reversed.`, userCode, userName }); } catch { /* ignore */ }
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error reversing loading sales batch:', error);
    res.status(500).json({ message: 'Failed to reverse the batch — nothing was changed.' });
  } finally { client.release(); }
});

export default router;
