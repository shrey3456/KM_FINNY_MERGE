// SAP codes live on the Product Master PER STATE only: gj_sap, mp_sap, up_sap. There is no general SAP any more (products.sap_code is no longer used
// for matching, display or stock). A plant's state decides which of the product's SAPs applies; a product with none for that state has a BLANK SAP there
// (and the app tells the user: "No SAP for this plant").
//
// Two products can share one barcode (65 g and 60 g packs): they are told apart by SAP. A SAP coming from a CSV or a slip is matched against all three
// state columns, so it points to exactly one product whichever plant the file is for.
import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;

export type StateCode = 'GJ' | 'MP' | 'UP';
const SAP_COLS = ['gj_sap', 'mp_sap', 'up_sap'] as const;
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

export const stateCodeOf = (state: string | null | undefined): StateCode | null => {
  const s = String(state ?? '').trim().toUpperCase();
  return s === 'GJ' || s === 'MP' || s === 'UP' ? s : null;
};

// A product row (raw snake_case from SQL, or camelCase from drizzle): its own SAP for the state, or null.
export function stateSapOf(p: any, state: string | null | undefined): string | null {
  const s = stateCodeOf(state);
  if (!s || !p) return null;
  const v = s === 'GJ' ? (p.gj_sap ?? p.gjSap) : s === 'MP' ? (p.mp_sap ?? p.mpSap) : (p.up_sap ?? p.upSap);
  const t = String(v ?? '').trim();
  return t || null;
}

// Any SAP the product has (state order GJ, MP, UP) - only for places with no plant at all (a legacy import with no plant).
export function anyStateSap(p: any): string | null {
  for (const s of ['GJ', 'MP', 'UP'] as const) { const v = stateSapOf(p, s); if (v) return v; }
  return null;
}

function hasSap(p: any, sap: string): boolean {
  const k = norm(sap);
  return SAP_COLS.some((c) => norm(p[c] ?? p[c.replace(/_(\w)/g, (_, ch) => ch.toUpperCase())]) === k);
}

// Which of the products that share a barcode a line means. One product -> it. Several -> the one whose SAP (state column first, then any) equals the
// line's SAP; with no SAP, or none matching, the one that has a SAP for the plant's state, else the lowest id.
export function pickBySap<T extends Record<string, any>>(rows: T[], sap: string | null | undefined, state: string | null | undefined): T | null {
  if (rows.length <= 1) return rows[0] ?? null;
  const k = norm(sap);
  if (k) {
    const own = rows.find((r) => norm(stateSapOf(r, state)) === k);
    if (own) return own;
    const any = rows.find((r) => hasSap(r, k));
    if (any) return any;
  }
  return rows.find((r) => !!stateSapOf(r, state)) ?? rows[0];
}

export async function productsForBarcode(db: Db, barcode: string): Promise<any[]> {
  const bc = String(barcode ?? '').trim();
  if (!bc) return [];
  return (await db.query(`SELECT * FROM products WHERE LOWER(TRIM(barcode)) = LOWER($1) ORDER BY id`, [bc])).rows;
}

export type LineProduct = {
  productId: number | null;
  name: string | null;
  sap: string | null;            // the product's SAP for the plant's state, or null
  noSapForPlant: boolean;        // the product is known but has no SAP for this plant's state
  twins: number;                 // how many products share the barcode
  row: any | null;               // the Product Master row
};

// The product a CSV / slip line means, and the SAP that applies at the plant.
export async function resolveLineProduct(db: Db, barcode: string, lineSap: string | null | undefined, plantState: string | null | undefined): Promise<LineProduct> {
  const rows = await productsForBarcode(db, barcode);
  const p = pickBySap(rows, lineSap, plantState);
  if (!p) return { productId: null, name: null, sap: null, noSapForPlant: false, twins: 0, row: null };
  const sap = stateSapOf(p, plantState);
  return { productId: p.id, name: p.name ?? null, sap, noSapForPlant: !sap, twins: rows.length, row: p };
}

export const noSapMessage = (itemName: string | null | undefined, barcode: string, plant: string | null | undefined, state: string | null | undefined) =>
  `No SAP for this plant: ${itemName || barcode} (${barcode}) has no ${stateCodeOf(state) ?? 'state'} SAP in the Product Master${plant ? `, so ${plant} shows it blank` : ''}.`;

// Before a CSV is imported: which of its lines are a known product that has NO SAP for the plant's state (they would show a blank SAP). The person is asked to
// confirm the import when this is not empty. One message per product.
export async function noSapWarningsForItems(
  db: Db, plant: string, items: Array<{ barcode?: string | null; itemName?: string | null; sapCode?: string | null }>,
): Promise<string[]> {
  const { rows } = await db.query(`SELECT state FROM plants WHERE LOWER(name) = LOWER($1) LIMIT 1`, [plant]);
  const state: string | null = rows[0]?.state ?? null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const barcode = String(it.barcode ?? '').trim();
    if (!barcode) continue;
    const lp = await resolveLineProduct(db, barcode, it.sapCode ?? null, state);
    if (!lp.productId || !lp.noSapForPlant) continue;
    const key = `${barcode.toLowerCase()}|${lp.productId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(noSapMessage(it.itemName || lp.name, barcode, plant, state));
  }
  return out;
}
