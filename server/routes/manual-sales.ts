import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';
import { ensureManualSalesTables } from '../lib/manualSalesSchema';
import { getPooledStock, getStatePlantNames, debitStatePool, creditStatePool, type StockPullContribution } from '../lib/statePool';

// Settings > Data Management > "Manual Sales" — a day's sales for dates that have no Load Operation. A CSV
// (Barcode, Item Name, Quantity and — when the file has one — Plant, all mapped in the dialog) is uploaded for
// ONE sale date. Each row is sold from its own PLANT (the CSV's Plant column; the dialog's plant is only the
// fallback for a file without one), and stock is taken from that plant's whole STATE pool exactly like a Loading
// scan (own plant first, then the others). Each take is kept per plant (manual_sale_pulls) so a reversal gives
// it back where it came from, and the sale is dated sale_date in Stock Overview's Sale column (sale_rows in
// scan-sessions.ts). Stock never goes below zero: when the pool holds less than the CSV row asks for, the row sells
// what there is (status 'partial'); a row with no stock at all has nothing to sell and is skipped.
//
// A row is matched on its BARCODE; the name is the check. Same barcode + same name = fine. When they disagree —
// the barcode is in the Product Master under another name, or the barcode is unknown — the row "needs a choice":
// the dialog offers the products it could mean (the one with that barcode, the one(s) with that name, and similar
// names) with their stock, and the person picks the one whose stock is to go down, or skips the row. Nothing is
// guessed. A plant that does not exist and a quantity below zero are skipped; a quantity of 0 is simply no sale.
const router = Router();
// Every manual-sales route makes sure its tables exist first (see server/lib/manualSalesSchema.ts).
router.use('/manual-sales', async (_req, res, next) => {
  try { await ensureManualSalesTables(); next(); } catch (e) { console.error('[Manual Sales] tables unavailable:', e); res.status(500).json({ message: 'Manual Sales is not available — its tables could not be created.' }); }
});

function actor(req: Request): { userCode?: string; userName?: string } {
  const u = req.user as any;
  return { userCode: u?.userCode, userName: u?.name || u?.username || u?.userCode };
}

type InRow = { plant?: string | null; barcode?: string; itemName?: string | null; quantity?: number };
type RowStatus = 'ok' | 'partial' | 'name_differs' | 'not_found' | 'bad_qty' | 'bad_plant' | 'short' | 'zero';
type Option = { id: number; barcode: string; name: string; source: 'barcode' | 'name' | 'similar'; available: number; enough: boolean; canSell: boolean };
type Evaluated = {
  key: string;                     // plant|barcode (lower case) — what the dialog sends back with a choice
  plant: string | null;            // canonical plant name, null when unknown
  csvPlant: string | null;
  barcode: string;                 // as in the CSV
  canonicalBarcode: string | null; // the Product Master item whose stock is taken (the chosen one, when a choice was made)
  productId: number | null;
  csvName: string | null;
  masterName: string | null;
  qty: number;                     // what the CSV asks for
  sellQty: number;                 // what is actually taken (less than qty when the stock is short)
  status: RowStatus;
  available: number | null;
  needsChoice: boolean;            // the person must pick a product (or skip the row)
  options: Option[];
  chosen: boolean;                 // the product above is the person's choice, not the CSV barcode's own
};
// Stock is kept per BARCODE (product_plant_stock), so two Product Master items that share one barcode share one pile of boxes;
// which of them a row is for decides the name it is recorded under, not the pile it comes from.

const normName = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const tokens = (s: string | null | undefined) => new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0));
// How alike two names are, 0..1 (shared words over all words). "48GM*150 TIKHA MITHA MIX" vs "230GM*20 TIKHA MITHA MIX" is high.
function similarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = tokens(a); const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export async function evaluate(defaultPlant: string | null, items: InRow[], choices?: Map<string, string>): Promise<Evaluated[]> {
  const { rows: plantRows } = await pool.query(`SELECT name FROM plants`);
  const plantByLower = new Map<string, string>(plantRows.map((p: any) => [String(p.name).trim().toLowerCase(), p.name]));

  // The same barcode on several CSV lines for the same plant is one sale of the summed quantity.
  const merged = new Map<string, { plant: string | null; csvPlant: string | null; barcode: string; csvName: string | null; qty: number; names: { name: string; qty: number }[] }>();
  for (const it of items) {
    const barcode = String(it.barcode ?? '').trim();
    if (!barcode) continue;
    const csvPlant = String(it.plant ?? '').trim() || null;
    const wanted = (csvPlant ?? defaultPlant ?? '').trim();
    const plant = plantByLower.get(wanted.toLowerCase()) ?? null;
    const qty = Math.round(Number(it.quantity) || 0);
    const key = `${(plant ?? `?${wanted.toLowerCase()}`)}|${barcode.toLowerCase()}`;
    const cur = merged.get(key);
    const nm = it.itemName ? String(it.itemName).trim() : '';
    if (cur) { cur.qty += qty; if (!cur.csvName && nm) cur.csvName = nm; if (nm) cur.names.push({ name: nm, qty }); }
    else merged.set(key, { plant, csvPlant: csvPlant ?? defaultPlant, barcode, csvName: nm || null, qty, names: nm ? [{ name: nm, qty }] : [] });
  }

  const { rows: products } = await pool.query(`SELECT id, barcode, name FROM products WHERE barcode IS NOT NULL ORDER BY id`);
  type Prod = { id: number; barcode: string; name: string };
  const all: Prod[] = (products as any[]).map((p) => ({ id: p.id, barcode: String(p.barcode).trim(), name: p.name }));
  const byBarcode = new Map<string, Prod[]>();
  const byName = new Map<string, Prod[]>();
  const byId = new Map<number, Prod>();
  for (const p of all) {
    byId.set(p.id, p);
    const k = p.barcode.toLowerCase();
    if (!byBarcode.has(k)) byBarcode.set(k, []);
    byBarcode.get(k)!.push(p);
    const nk = normName(p.name);
    if (nk) { if (!byName.has(nk)) byName.set(nk, []); byName.get(nk)!.push(p); }
  }

  // Plants of one state share a pool, so two rows (say Valsad and Baroda) can draw on the same boxes. Boxes already
  // promised to an earlier row of this file are not offered again — the same order the apply step takes them in.
  const promised = new Map<string, number>();
  const stateKeyOf = new Map<string, string>();
  const poolKey = async (plant: string, barcode: string) => {
    let sk = stateKeyOf.get(plant);
    if (!sk) { sk = (await getStatePlantNames(pool, plant)).map((n) => n.toLowerCase()).sort().join(','); stateKeyOf.set(plant, sk); }
    return `${sk}|${barcode.toLowerCase()}`;
  };
  const availableFor = async (plant: string, barcode: string) => {
    const pooled = await getPooledStock(pool, barcode, plant);
    return pooled.total - (promised.get(await poolKey(plant, barcode)) ?? 0);
  };
  const promise = async (plant: string, barcode: string, qty: number) => {
    const k = await poolKey(plant, barcode);
    promised.set(k, (promised.get(k) ?? 0) + qty);
  };
  // How much of a row can be sold from what is left in the pool: all of it, only part of it, or none.
  const settle = async (plant: string, barcode: string, qty: number, available: number) => {
    const sell = Math.max(0, Math.min(qty, available));
    if (sell > 0) await promise(plant, barcode, sell);
    return { status: (sell === 0 ? 'short' : sell < qty ? 'partial' : 'ok') as RowStatus, sellQty: sell };
  };

  const out: Evaluated[] = [];
  for (const [mkey, m] of merged) {
    const key = mkey.toLowerCase();
    const blank = { key, plant: m.plant, csvPlant: m.csvPlant, barcode: m.barcode, csvName: m.csvName, qty: m.qty, sellQty: 0, needsChoice: false, options: [] as Option[], chosen: false };
    if (!m.plant) { out.push({ ...blank, canonicalBarcode: null, productId: null, masterName: null, status: 'bad_plant', available: null }); continue; }
    if (m.qty === 0) {
      const p0 = byBarcode.get(m.barcode.toLowerCase())?.[0];
      out.push({ ...blank, canonicalBarcode: p0?.barcode ?? null, productId: p0?.id ?? null, masterName: p0?.name ?? null, status: 'zero', available: null });
      continue;
    }
    if (m.qty < 0) {
      const p0 = byBarcode.get(m.barcode.toLowerCase())?.[0];
      out.push({ ...blank, canonicalBarcode: p0?.barcode ?? null, productId: p0?.id ?? null, masterName: p0?.name ?? null, status: 'bad_qty', available: null });
      continue;
    }

    // The person already chose which product's stock this row takes.
    const chosenId = choices?.get(key);
    if (chosenId) {
      const cp = byId.get(Number(chosenId));
      if (!cp) { out.push({ ...blank, canonicalBarcode: null, productId: null, masterName: null, status: 'not_found', available: null }); continue; }
      const available = await availableFor(m.plant, cp.barcode);
      const st = await settle(m.plant, cp.barcode, m.qty, available);
      out.push({ ...blank, canonicalBarcode: cp.barcode, productId: cp.id, masterName: cp.name, status: st.status, sellQty: st.sellQty, available, chosen: true });
      continue;
    }

    const matches = byBarcode.get(m.barcode.toLowerCase());
    // The same barcode can sit on several CSV lines (an old and a new pack, say) where only one actually sells: the name
    // check looks at the lines that carry a quantity, and passes when any of them is the Product Master's name.
    const sellingNames = m.names.filter((n) => n.qty !== 0).map((n) => n.name);
    const namesToCheck = sellingNames.length > 0 ? sellingNames : m.names.map((n) => n.name);
    // Products on this barcode whose name is the CSV's name. One match = that product. Several products sharing the barcode and
    // none (or no name in the CSV) = ambiguous, so the person picks — the first product is never assumed.
    const nameHits = matches ? matches.filter((x) => namesToCheck.some((nm) => normName(x.name) === normName(nm))) : [];
    const unambiguous = !!matches && (nameHits.length > 0 || (namesToCheck.length === 0 && matches.length === 1));

    if (matches && unambiguous) {
      const p = nameHits[0] ?? matches[0];
      const available = await availableFor(m.plant, p.barcode);
      const st = await settle(m.plant, p.barcode, m.qty, available);
      out.push({ ...blank, canonicalBarcode: p.barcode, productId: p.id, masterName: p.name, status: st.status, sellQty: st.sellQty, available });
      continue;
    }

    // Barcode and name disagree (or the barcode is unknown): offer what it could be — the item with that barcode, the
    // item(s) with that name, and a few alike names — each with its stock, so the person can pick.
    const csvName = sellingNames[0] ?? m.csvName;
    const seen = new Set<string>();
    const picks: { p: Prod; source: Option['source'] }[] = [];
    const add = (p: Prod, source: Option['source']) => { const k = String(p.id); if (!seen.has(k)) { seen.add(k); picks.push({ p, source }); } };
    if (matches) matches.forEach((p) => add(p, 'barcode'));
    if (csvName) for (const p of byName.get(normName(csvName)) ?? []) add(p, 'name');
    if (csvName) {
      all.map((p) => ({ p, s: similarity(csvName, p.name) })).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s).slice(0, 4).forEach((x) => add(x.p, 'similar'));
    }
    const options: Option[] = [];
    for (const x of picks.slice(0, 8)) {
      const available = await availableFor(m.plant, x.p.barcode);
      options.push({ id: x.p.id, barcode: x.p.barcode, name: x.p.name, source: x.source, available, enough: available >= m.qty, canSell: available > 0 });
    }
    const p0 = matches?.[0];
    out.push({
      ...blank, canonicalBarcode: p0?.barcode ?? null, productId: p0?.id ?? null, masterName: p0?.name ?? null,
      status: matches ? 'name_differs' : 'not_found', available: p0 ? await availableFor(m.plant, p0.barcode) : null,
      needsChoice: options.length > 0, options,
    });
  }
  return out;
}

function validateDate(req: Request, res: Response): string | null {
  const saleDate = String(req.body?.saleDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) { res.status(400).json({ message: 'Pick the sale date' }); return null; }
  return saleDate;
}

const defaultPlantOf = (req: Request): string | null => String(req.body?.plant ?? '').trim() || null;

const countOf = (rows: Evaluated[]) => ({
  ok: rows.filter((r) => r.status === 'ok').length,
  partial: rows.filter((r) => r.status === 'partial').length,
  needsChoice: rows.filter((r) => r.needsChoice).length,
  nameDiffers: rows.filter((r) => r.status === 'name_differs').length,
  notFound: rows.filter((r) => r.status === 'not_found' && !r.needsChoice).length,
  short: rows.filter((r) => r.status === 'short').length,
  badQty: rows.filter((r) => r.status === 'bad_qty').length,
  badPlant: rows.filter((r) => r.status === 'bad_plant').length,
  zero: rows.filter((r) => r.status === 'zero').length,
});

// POST /api/manual-sales/preview — body { saleDate, plant?, items:[{plant?,barcode,itemName,quantity}] } — every
// row's status and, for a row that needs a choice, the products it could be; nothing is changed.
router.post('/manual-sales/preview', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const saleDate = validateDate(req, res);
    if (!saleDate) return;
    const items: InRow[] = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ message: 'CSV has no rows' });
    const rows = await evaluate(defaultPlantOf(req), items);
    const plants = Array.from(new Set(rows.filter((r) => r.status === 'ok' || r.status === 'partial' || r.needsChoice).map((r) => r.plant!)));
    res.json({
      rows, counts: countOf(rows), plants,
      totalQty: rows.filter((r) => r.status === 'ok' || r.status === 'partial').reduce((s, r) => s + r.sellQty, 0),
      shortBoxes: rows.filter((r) => r.status === 'partial').reduce((s, r) => s + (r.qty - r.sellQty), 0),
    });
  } catch (error) {
    console.error('Error previewing manual sales:', error);
    res.status(500).json({ message: 'Failed to preview manual sales' });
  }
});

// POST /api/manual-sales/apply — body { saleDate, plant?, csvFileName, items, choices, allowDuplicate }
// choices = { "<row key>": "<id of the Product Master item chosen>" } for the rows that needed one; a row that
// needed a choice and has none is skipped. One batch is saved per plant, all in one transaction (everything or nothing).
router.post('/manual-sales/apply', requireAdminRole, async (req: Request, res: Response) => {
  const saleDate = validateDate(req, res);
  if (!saleDate) return;
  const items: InRow[] = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) return res.status(400).json({ message: 'CSV has no rows' });
  const csvFileName = String(req.body?.csvFileName ?? '').trim() || null;
  const { userCode, userName } = actor(req);

  const rawChoices = req.body?.choices;
  const choices = new Map<string, string>();
  if (rawChoices && typeof rawChoices === 'object') {
    for (const [k, v] of Object.entries(rawChoices)) { const b = String(v ?? '').trim(); if (b) choices.set(k.toLowerCase(), b); }
  }
  const evaluated = await evaluate(defaultPlantOf(req), items, choices);
  const counts = countOf(evaluated);
  if (counts.needsChoice > 0 && !(rawChoices && typeof rawChoices === 'object')) {
    return res.status(409).json({ needsChoice: true, message: `${counts.needsChoice} row(s) need you to pick which product to take the stock from.`, counts });
  }
  const applicable = evaluated.filter((r) => r.status === 'ok' || r.status === 'partial');
  if (applicable.length === 0) return res.status(400).json({ message: 'Nothing can be added — every row was skipped.', counts });

  const byPlant = new Map<string, Evaluated[]>();
  for (const r of applicable) { if (!byPlant.has(r.plant!)) byPlant.set(r.plant!, []); byPlant.get(r.plant!)!.push(r); }

  // Do not let the same file + date + plant go in twice by accident.
  if (csvFileName && req.body?.allowDuplicate !== true) {
    for (const plant of byPlant.keys()) {
      const dup = await pool.query(
        `SELECT id FROM manual_sale_batches WHERE status = 'active' AND csv_file_name = $1 AND sale_date = $2::date AND LOWER(plant) = LOWER($3) LIMIT 1`,
        [csvFileName, saleDate, plant],
      );
      if (dup.rows[0]) return res.status(409).json({ duplicate: true, message: `"${csvFileName}" was already added for ${saleDate} at ${plant} (batch #${dup.rows[0].id}).` });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batches: { batchId: number; plant: string; rows: number; qty: number }[] = [];
    for (const [plant, list] of byPlant) {
      const totalQty = list.reduce((s, r) => s + r.sellQty, 0);
      const { rows: batchRows } = await client.query(
        `INSERT INTO manual_sale_batches (sale_date, plant, csv_file_name, row_count, total_qty, created_by_code, created_by_name)
         VALUES ($1::date, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [saleDate, plant, csvFileName, list.length, totalQty, userCode ?? null, userName ?? null],
      );
      const batchId: number = batchRows[0].id;
      batches.push({ batchId, plant, rows: list.length, qty: totalQty });

      for (const r of list) {
        const barcode = r.canonicalBarcode!;
        const contributions = await debitStatePool(client, barcode, plant, r.sellQty, r.productId);
        const { rows: rowIns } = await client.query(
          `INSERT INTO manual_sale_rows (batch_id, barcode, item_name, product_id, qty, name_differs, csv_barcode, csv_name, requested_qty)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [batchId, barcode, r.masterName, r.productId, r.sellQty, r.chosen, r.barcode, r.csvName, r.qty],
        );
        const rowId: number = rowIns[0].id;
        const mapped = (r.chosen ? ` — CSV said ${r.barcode}${r.csvName ? ` "${r.csvName}"` : ''}, product chosen by the person` : '')
          + (r.sellQty < r.qty ? ` — CSV asked for ${r.qty}, only ${r.sellQty} in stock` : '');
        for (const c of contributions) {
          await client.query(`INSERT INTO manual_sale_pulls (row_id, source_plant, qty) VALUES ($1,$2,$3)`, [rowId, c.plant, c.qty]);
          // Audit trail only — Stock Overview takes Sale from manual_sale_pulls and ignores 'dispatch' ledger rows.
          await client.query(
            `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
             VALUES ($1,$2,$3,$4,0,'dispatch',$5,$6,'manual-sale')`,
            [barcode, r.productId, c.plant, -c.qty,
              (c.plant.toLowerCase() === plant.toLowerCase()
                ? `Manual sale ${saleDate} (${csvFileName ?? 'CSV'})`
                : `Manual sale ${saleDate} (${csvFileName ?? 'CSV'}) — pooled from ${c.plant} for ${plant}`) + mapped,
              userCode ?? null],
          );
        }
        await client.query(
          `UPDATE products p SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(pps.barcode) = LOWER(p.barcode)), 0) WHERE LOWER(p.barcode) = LOWER($1)`,
          [barcode],
        );
      }
    }
    await client.query('COMMIT');

    for (const b of batches) {
      try {
        await storage.logActivity({
          pageName: 'Settings', action: 'create', entityType: 'manual_sale_batch', entityId: String(b.batchId),
          details: `Manual sales added for ${saleDate} at ${b.plant} from ${csvFileName ?? 'a CSV'}: ${b.rows} item(s), ${b.qty} boxes.`,
          userCode, userName,
        });
      } catch { /* the sale matters more than its log line */ }
    }

    res.json({
      success: true, batches,
      rowsAdded: applicable.length, totalQty: applicable.reduce((s, r) => s + r.sellQty, 0),
      partialRows: applicable.filter((r) => r.sellQty < r.qty).length,
      shortBoxes: applicable.reduce((s, r) => s + (r.qty - r.sellQty), 0),
      skipped: evaluated.filter((r) => r.status !== 'ok' && r.status !== 'partial' && r.status !== 'zero')
        .map((r) => ({ plant: r.plant ?? r.csvPlant, barcode: r.barcode, status: r.needsChoice ? 'needs_choice' : r.status, name: r.csvName })),
    });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error adding manual sales:', error);
    res.status(error?.status ?? 500).json({ message: error?.message || 'Failed to add manual sales — nothing was changed.' });
  } finally {
    client.release();
  }
});

// GET /api/manual-sales/batches — recent batches, newest first.
router.get('/manual-sales/batches', requireAdminRole, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, sale_date::text AS "saleDate", plant, csv_file_name AS "csvFileName", row_count AS "rowCount", total_qty AS "totalQty",
              status, created_by_name AS "createdByName", created_by_code AS "createdByCode", created_at AS "createdAt", reversed_at AS "reversedAt"
         FROM manual_sale_batches ORDER BY id DESC LIMIT 100`,
    );
    res.json({ batches: rows });
  } catch (error) {
    console.error('Error listing manual sale batches:', error);
    res.status(500).json({ message: 'Failed to load manual sale batches' });
  }
});

// Gives one active batch's boxes back to the plants they came from and takes it out of Sale. Runs inside the caller's
// transaction (the Manual Sales reverse button, and "Load from Sales Orders file" when it replaces a day's manual sales).
// Returns the batch row, 'missing' when there is no such batch, or 'done' when it was already reversed.
export async function reverseManualSaleBatch(client: any, id: number, userCode: string | null): Promise<any | 'missing' | 'done'> {
  const { rows: b } = await client.query(`SELECT * FROM manual_sale_batches WHERE id = $1 FOR UPDATE`, [id]);
  if (!b[0]) return 'missing';
  if (b[0].status !== 'active') return 'done';
  const { rows: rows } = await client.query(`SELECT id, barcode, product_id FROM manual_sale_rows WHERE batch_id = $1`, [id]);
  for (const r of rows) {
    const { rows: pulls } = await client.query(`SELECT source_plant AS plant, qty FROM manual_sale_pulls WHERE row_id = $1`, [r.id]);
    const contributions = pulls as StockPullContribution[];
    await creditStatePool(client, r.barcode, contributions);
    for (const c of contributions) {
      await client.query(
        `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
         VALUES ($1,$2,$3,$4,0,'dispatch',$5,$6,'manual-sale')`,
        [r.barcode, r.product_id, c.plant, c.qty, `Manual sale batch #${id} reversed`, userCode],
      );
    }
    await client.query(
      `UPDATE products p SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(pps.barcode) = LOWER(p.barcode)), 0) WHERE LOWER(p.barcode) = LOWER($1)`,
      [r.barcode],
    );
  }
  await client.query(`UPDATE manual_sale_batches SET status = 'reversed', reversed_at = NOW(), reversed_by_code = $2 WHERE id = $1`, [id, userCode]);
  return b[0];
}

// POST /api/manual-sales/batches/:id/reverse — gives every box back to the plant it came from and takes the
// batch out of Sale. The batch stays in the list as "reversed".
router.post('/manual-sales/batches/:id/reverse', requireAdminRole, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Bad batch id' });
  const { userCode, userName } = actor(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = await reverseManualSaleBatch(client, id, userCode ?? null);
    if (batch === 'missing') { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Batch not found' }); }
    if (batch === 'done') { await client.query('ROLLBACK'); return res.status(409).json({ message: 'This batch was already reversed.' }); }
    const b = [batch];
    await client.query('COMMIT');
    try {
      await storage.logActivity({
        pageName: 'Settings', action: 'delete', entityType: 'manual_sale_batch', entityId: String(id),
        details: `Manual sale batch #${id} (${b[0].csv_file_name ?? 'CSV'}, ${b[0].sale_date}, ${b[0].plant}) reversed — ${b[0].total_qty} boxes returned to stock.`,
        userCode, userName,
      });
    } catch { /* ignore */ }
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error reversing manual sale batch:', error);
    res.status(500).json({ message: 'Failed to reverse the batch — nothing was changed.' });
  } finally {
    client.release();
  }
});

export default router;
