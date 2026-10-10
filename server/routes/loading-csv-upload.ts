import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { WRITE_ADMIN_ROLES } from '../lib/pageAccess';
import { getPlantStateCode } from './order-scan';

// CSV upload for loads that already left the warehouse — PREVIEW ONLY.
// Nothing is saved by this route: no slip changes, no load records, no stock, no sales, no Notion.
//
// Rules:
//   - Plant comes from each order's proforma slip. If a slip has no plant, the caller may send
//     plantsByOrder to choose one for this preview only. It is never written to the slip.
//   - A line is matched by SAP code, using the SAP column for that plant's state.
//   - An unmatched or ambiguous line can be linked to a product the user picked (links), or
//     skipped (skips). Nothing is saved from the choice here.
//   - Quantity is the CSV number as-is. Against the slip: same, extra (CSV more), less (CSV less),
//     or new extra (not on the slip). Slip lines not in the CSV are listed and left alone.
//   - Orders not in the system, and orders already recorded, are reported and skipped.

const router = Router();

function isAdminRole(req: Request): boolean {
  const role = ((req.user as any)?.role ?? '').toString().toLowerCase();
  return WRITE_ADMIN_ROLES.includes(role);
}

function requireUploadAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdminRole(req)) return res.status(403).json({ message: 'Only an admin can upload a load CSV.' });
  next();
}

// Minimal CSV reader: quoted fields may contain commas, doubled quotes and line breaks.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else { inQuotes = false; }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

const DATE_CELL = /^\d{1,2}-[A-Za-z]{3}-\d{2}$/;
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// "1-Oct-26" -> "2026-10-01"
export function parseCsvDate(raw: string): string | null {
  // 10/01/2026 (month/day/year, as the Sales Orders export writes Bill Date)
  const sl = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (sl) return `${sl[3]}-${sl[1].padStart(2, '0')}-${sl[2].padStart(2, '0')}`;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  return `20${m[3]}-${mm}-${m[1].padStart(2, '0')}`;
}

// "100239 (30GM*120 CRUNCHEX CHILI TADKA WAFERS)" or "8100002\n (ADVERTISEMENT ...)" -> sap + name
export function parseItemCell(raw: string): { sapCode: string | null; name: string } {
  const text = raw.replace(/\s+/g, ' ').trim();
  const m = /^(\d+)\s*\((.*)\)\s*$/.exec(text);
  if (!m) return { sapCode: null, name: text };
  return { sapCode: m[1], name: m[2].trim() };
}

// "60.0000 CAR" -> { qty: 60, unit: "CAR" }, "5 NOS" -> { qty: 5, unit: "NOS" }
export function parseQtyCell(raw: string): { qty: number | null; unit: string } {
  const text = raw.trim();
  const m = /^([\d.]+)\s*(.*)$/.exec(text);
  if (!m) return { qty: null, unit: '' };
  const qty = Number(m[1]);
  return { qty: Number.isFinite(qty) ? qty : null, unit: m[2].trim() };
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

// The key that ties a CSV line to a user's choice (link / skip). Same on every preview run.
export function lineKey(orderNumber: string, sapCode: string | null, csvName: string): string {
  return `${orderNumber}|${sapCode ?? ''}|${csvName}`;
}

// Word-overlap score (0..1) between two product names, ignoring pack-size tokens like "15GM*192".
function nameTokens(name: string): string[] {
  return name.toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length > 1 && !/\d/.test(t));
}
function similarity(a: string, b: string): number {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / new Set([...ta, ...tb]).size;
}

type ProductRow = { id: number; barcode: string; name: string; sap_code: string | null; gj_sap: string | null; mp_sap: string | null };

// SAP lookup for one plant state: GJ plants read the GJ SAP column, others the MP column.
// sap_code is the fallback for both, as the order import already does.
function buildSapMap(products: ProductRow[], state: string | null): Map<string, ProductRow[]> {
  const cols = state === 'GJ' ? ['gj_sap', 'sap_code'] : ['mp_sap', 'sap_code'];
  const map = new Map<string, ProductRow[]>();
  for (const p of products) {
    for (const col of cols) {
      const code = norm((p as any)[col]);
      if (!code) continue;
      const list = map.get(code) ?? [];
      if (!list.some((x) => x.id === p.id)) list.push(p);
      map.set(code, list);
    }
  }
  return map;
}

router.post('/loading/csv-upload/preview', requireUploadAdmin, async (req: Request, res: Response) => {
  try {
    const csvText = String(req.body?.csvText ?? '');
    const plantsByOrder: Record<string, string> = (req.body?.plantsByOrder && typeof req.body.plantsByOrder === 'object') ? req.body.plantsByOrder : {};
    const links: Array<{ key: string; productId: number }> = Array.isArray(req.body?.links) ? req.body.links : [];
    const skips: string[] = Array.isArray(req.body?.skips) ? req.body.skips.map(String) : [];
    if (!csvText.trim()) return res.status(400).json({ message: 'The CSV file is empty.' });

    // 1. Read the data rows: a row is a data row when its first cell is a date.
    const rows = parseCsv(csvText);
    type CsvLine = { date: string | null; orderNumber: string; party: string; sapCode: string | null; csvName: string; csvQty: number | null; unit: string };
    const lines: CsvLine[] = [];
    // Two layouts: the older one (Date, Order Number, Party, "SAP (name)", "60.0000 CAR") and the newer Sales Orders export
    // ([Date,] Order No., Bill Date, Party Name, State, SAP, Product name, Qty) — recognised from the header row.
    const norm2 = (v: string) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const headerIdx = rows.findIndex((r) => r.some((c) => norm2(c) === 'orderno') && r.some((c) => norm2(c) === 'sap'));
    if (headerIdx >= 0) {
      const h = rows[headerIdx].map(norm2);
      const col = (...names: string[]) => h.findIndex((x) => names.includes(x));
      const cOrder = col('orderno', 'ordernumber'), cDate = col('date', 'billdate'), cParty = h.findIndex((x) => x.startsWith('partyname')),
        cSap = col('sap', 'sapcode'), cName = h.findIndex((x) => x.includes('products') || x.includes('itemname') || x === 'nameofitem'), cQty = col('qty', 'quantity');
      for (const r of rows.slice(headerIdx + 1)) {
        const orderNumber = String(r[cOrder] ?? '').trim();
        if (!orderNumber || !/\d/.test(orderNumber)) continue;
        const q = Number(String(r[cQty] ?? '').replace(/,/g, '').trim());
        lines.push({
          date: cDate >= 0 ? parseCsvDate(String(r[cDate] ?? '')) : null,
          orderNumber,
          party: cParty >= 0 ? String(r[cParty] ?? '').trim() : '',
          sapCode: String(r[cSap] ?? '').trim() || null,
          csvName: String(r[cName] ?? '').replace(/\s+/g, ' ').trim(),
          csvQty: Number.isFinite(q) ? q : null,
          unit: '',
        });
      }
    } else {
      for (const r of rows) {
        if (!r[0] || !DATE_CELL.test(r[0].trim())) continue;
        const item = parseItemCell(r[3] ?? '');
        const qty = parseQtyCell(r[4] ?? '');
        lines.push({
          date: parseCsvDate(r[0]),
          orderNumber: String(r[1] ?? '').trim(),
          party: String(r[2] ?? '').trim(),
          sapCode: item.sapCode,
          csvName: item.name,
          csvQty: qty.qty,
          unit: qty.unit,
        });
      }
    }
    if (lines.length === 0) {
      return res.status(400).json({ message: 'No order lines found. The file needs an Order No. column and a SAP column (and a Date, e.g. 1-Oct-26).' });
    }

    // 2. Product Master, once.
    const { rows: productRows } = await pool.query(
      `SELECT id, barcode, name, sap_code, gj_sap, mp_sap FROM products WHERE barcode IS NOT NULL AND TRIM(barcode) <> ''`,
    ) as { rows: ProductRow[] };
    const productById = new Map<number, ProductRow>(productRows.map((p) => [p.id, p]));
    const sapMapByState = new Map<string, Map<string, ProductRow[]>>();
    const sapMapFor = async (plant: string) => {
      const state = await getPlantStateCode(pool, plant);
      const key = state ?? '';
      if (!sapMapByState.has(key)) sapMapByState.set(key, buildSapMap(productRows, state));
      return sapMapByState.get(key)!;
    };

    // 3. Slips for every order in the file, and what's already on them.
    const orderNumbers = [...new Set(lines.map((l) => l.orderNumber).filter(Boolean))];
    const { rows: slipRows } = await pool.query(
      `SELECT id, order_number, plant, party_name, order_date::text AS order_date, vehicle_number, loading_completed_at
         FROM proforma_slips WHERE order_number = ANY($1)`,
      [orderNumbers],
    );
    const slipByOrder = new Map<string, any>(slipRows.map((s) => [String(s.order_number), s]));
    const { rows: recordedRows } = await pool.query(
      `SELECT DISTINCT order_number FROM loading_scan_events WHERE order_number = ANY($1) AND COALESCE(voided, false) = false`,
      [orderNumbers],
    );
    const recorded = new Set(recordedRows.map((r) => String(r.order_number)));
    const slipIds = slipRows.map((s) => s.id);
    const { rows: slipItemRows } = slipIds.length
      ? await pool.query(
          `SELECT proforma_slip_id AS slip_id, barcode, item_name, sap_code, quantity FROM proforma_slip_items WHERE proforma_slip_id = ANY($1)`,
          [slipIds],
        )
      : { rows: [] as any[] };
    const slipItemsBySlip = new Map<number, any[]>();
    for (const it of slipItemRows) {
      const list = slipItemsBySlip.get(it.slip_id) ?? [];
      list.push(it);
      slipItemsBySlip.set(it.slip_id, list);
    }

    // 4. Group the lines by order and decide each order's status.
    const grouped = new Map<string, CsvLine[]>();
    for (const l of lines) {
      const list = grouped.get(l.orderNumber) ?? [];
      list.push(l);
      grouped.set(l.orderNumber, list);
    }

    const orders: any[] = [];
    for (const [orderNumber, orderLines] of grouped.entries()) {
      const base = { orderNumber, date: orderLines[0]?.date ?? null, party: orderLines[0]?.party ?? '' };
      const slip = slipByOrder.get(orderNumber);
      if (!slip) { orders.push({ ...base, plant: null, status: 'notInSystem', lines: [], slipOnly: [] }); continue; }
      if (recorded.has(orderNumber) || slip.loading_completed_at) {
        orders.push({ ...base, plant: slip.plant ?? null, status: 'alreadyRecorded', lines: [], slipOnly: [] });
        continue;
      }
      // The slip's plant is the plant. Only when the slip has none is the user's pick used, and
      // that pick is for this preview only — it is never written to the slip.
      const plant = String(slip.plant ?? '').trim() || String(plantsByOrder[orderNumber] ?? '').trim();
      if (!plant) {
        orders.push({ ...base, plant: null, status: 'needsPlant', lines: [], slipOnly: [] });
        continue;
      }

      const sapMap = await sapMapFor(plant);
      const slipItems = slipItemsBySlip.get(slip.id) ?? [];
      const slipByBarcode = new Map<string, any>();
      for (const it of slipItems) slipByBarcode.set(norm(it.barcode), it);
      const csvBarcodes = new Set<string>();

      const resultLines = orderLines.map((l) => {
        const key = lineKey(orderNumber, l.sapCode, l.csvName);
        const base2 = { key, sapCode: l.sapCode, csvName: l.csvName, csvQty: l.csvQty, unit: l.unit };
        if (skips.includes(key)) return { ...base2, status: 'skipped' as const };

        // A product the user picked for this line (linked) wins over the SAP lookup.
        const linkedId = links.find((x) => x.key === key)?.productId;
        let product: ProductRow | undefined;
        if (linkedId != null && productById.has(Number(linkedId))) {
          product = productById.get(Number(linkedId));
        } else {
          const candidates = l.sapCode ? (sapMap.get(norm(l.sapCode)) ?? []) : [];
          if (candidates.length !== 1) {
            // Suggestions: a product whose BARCODE is written in the line (its SAP cell or its name) first, then this order's own
            // slip lines that look like it (same SAP code or a similar name — the slip carries the barcode), then similar names.
            const out: Array<{ id: number; barcode: string; name: string; score: number; reason: string }> = [];
            const seen = new Set<number>();
            const add = (p: ProductRow | undefined, score: number, reason: string) => {
              if (!p || seen.has(p.id)) return; seen.add(p.id);
              out.push({ id: p.id, barcode: String(p.barcode), name: String(p.name ?? ''), score: Math.round(score * 100) / 100, reason });
            };
            const byBarcodeNorm = new Map<string, ProductRow[]>();
            for (const p of productRows) { const k = norm(p.barcode); const list = byBarcodeNorm.get(k) ?? []; list.push(p); byBarcodeNorm.set(k, list); }
            const tokens = new Set<string>([...(String(l.csvName).match(/d{8,}/g) ?? []), ...(l.sapCode && l.sapCode.length >= 8 ? [l.sapCode] : [])]);
            for (const t of tokens) for (const p of byBarcodeNorm.get(norm(t)) ?? []) add(p, 1, 'Barcode matches');
            for (const it of slipItems) {
              const sameSap = !!l.sapCode && norm(it.sap_code) === norm(l.sapCode);
              const sim = similarity(l.csvName, String(it.item_name ?? ''));
              if (sameSap || sim >= 0.3) for (const p of byBarcodeNorm.get(norm(it.barcode)) ?? []) add(p, sameSap ? 0.99 : sim, "On this order's slip");
            }
            for (const p of productRows
              .map((p) => ({ p, score: similarity(l.csvName, String(p.name ?? '')) }))
              .filter((x) => x.score >= 0.3)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)) add(p.p, p.score, 'Similar name');
            const suggestions = out.slice(0, 8);
            return {
              ...base2,
              status: candidates.length === 0 ? 'unmatched' as const : 'ambiguous' as const,
              candidates: candidates.map((c) => ({ id: c.id, barcode: String(c.barcode), name: String(c.name ?? '') })),
              suggestions,
            };
          }
          product = candidates[0];
        }

        const productInfo = { id: product!.id, barcode: String(product!.barcode), name: String(product!.name ?? '') };
        const barcodeKey = norm(productInfo.barcode);
        csvBarcodes.add(barcodeKey);
        const slipLine = slipByBarcode.get(barcodeKey);
        const csvQty = l.csvQty ?? 0;
        const linked = linkedId != null;
        if (!slipLine) {
          return { ...base2, status: 'newExtra' as const, linked, product: productInfo, slipQty: 0, csvQtyNum: csvQty, difference: csvQty };
        }
        const slipQty = Number(slipLine.quantity ?? 0);
        const difference = csvQty - slipQty;
        const status = difference === 0 ? 'same' as const : difference > 0 ? 'extra' as const : 'less' as const;
        return { ...base2, status, linked, product: productInfo, slipQty, csvQtyNum: csvQty, difference };
      });

      const slipOnly = slipItems
        .filter((it) => !csvBarcodes.has(norm(it.barcode)))
        .map((it) => ({ barcode: it.barcode, itemName: it.item_name, sapCode: it.sap_code, quantity: Number(it.quantity ?? 0) }));

      orders.push({ ...base, plant, plantFrom: String(slip.plant ?? '').trim() ? 'slip' : 'picked', status: 'ready', vehicleOnSlip: slip.vehicle_number ?? null, lines: resultLines, slipOnly });
    }

    const count = (pred: (l: any) => boolean) => orders.reduce((n, o: any) => n + (o.lines ?? []).filter(pred).length, 0);
    res.json({
      fileLines: lines.length,
      summary: {
        orders: orders.length,
        ready: orders.filter((o) => o.status === 'ready').length,
        needsPlant: orders.filter((o) => o.status === 'needsPlant').length,
        alreadyRecorded: orders.filter((o) => o.status === 'alreadyRecorded').length,
        notInSystem: orders.filter((o) => o.status === 'notInSystem').length,
        same: count((l) => l.status === 'same'),
        extra: count((l) => l.status === 'extra'),
        less: count((l) => l.status === 'less'),
        newExtra: count((l) => l.status === 'newExtra'),
        unmatched: count((l) => l.status === 'unmatched'),
        ambiguous: count((l) => l.status === 'ambiguous'),
        skipped: count((l) => l.status === 'skipped'),
      },
      orders,
    });
  } catch (err: any) {
    console.error('Load CSV preview failed:', err);
    res.status(500).json({ message: err?.message ?? 'Preview failed' });
  }
});

export default router;
