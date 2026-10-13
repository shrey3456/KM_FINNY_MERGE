import { eq } from 'drizzle-orm';
import { db, pool } from '../db';
import { products as productsTable, type Product } from '@shared/schema';

// Which Product Master product is this line? Some products share a barcode (the 35 g and the 37 g salted peanuts, one per state), so the
// barcode alone is not enough. A line is matched on its barcode AND its SAP code, and the SAP code that counts is the one for the PLANT'S STATE
// (GJ SAP for Rajkot / Valsad / Baroda, MP SAP for Indore, UP SAP for Lucknow). Used by Unloading (see server/routes/unloading.ts).
//
// With one product behind the barcode the answer is that product, exactly as before. With more than one, in this order:
//   1. the product whose SAP for the plant's state equals the line's SAP            (Rajkot, SAP 101822 -> V144, never I200)
//   2. the product that has the line's SAP in any state
//   3. the product that has a SAP for the plant's state
//   4. the product whose category belongs to the plant's state (VALSAD / INDORE; COMMON fits any)
//   5. the lowest id — so the answer never changes from one call to the next (the old lookup returned whichever row the database gave first).

const clean = (v: unknown) => String(v ?? '').trim().toLowerCase();

let plantStateCache: { at: number; byName: Map<string, string> } | null = null;
export async function stateOfPlant(plant: string | null | undefined): Promise<string | null> {
  const name = clean(plant);
  if (!name) return null;
  if (!plantStateCache || Date.now() - plantStateCache.at > 60_000) {
    const { rows } = await pool.query(`SELECT name, state FROM plants`);
    plantStateCache = { at: Date.now(), byName: new Map(rows.map((r: any) => [clean(r.name), String(r.state ?? '').trim().toUpperCase()])) };
  }
  return plantStateCache.byName.get(name) || null;
}

// The product's SAP code for a state ('' when none). The general SAP column stands in for GJ (it mirrors the GJ SAP).
export function productSapForState(p: Pick<Product, 'sapCode' | 'gjSap' | 'mpSap' | 'upSap'>, state: string | null): string {
  const pick = (v: unknown) => String(v ?? '').trim();
  if (state === 'GJ') return pick(p.gjSap) || pick(p.sapCode);
  if (state === 'MP') return pick(p.mpSap);
  if (state === 'UP') return pick(p.upSap);
  return '';
}

// A product's category names the plant (state) it is sold from: VALSAD / RAJKOT / BARODA = GJ, INDORE = MP, LUCKNOW = UP, COMMON = any.
function categoryFitsState(category: string | null | undefined, state: string | null): boolean {
  const c = String(category ?? '').trim().toUpperCase();
  if (!c || !state) return false;
  if (c === 'COMMON') return true;
  if (['VALSAD', 'RAJKOT', 'BARODA'].includes(c)) return state === 'GJ';
  if (c === 'INDORE') return state === 'MP';
  if (c === 'LUCKNOW') return state === 'UP';
  return false;
}

export function chooseProductForLine(
  candidates: Product[],
  sapCode: string | null | undefined,
  state: string | null,
): Product | undefined {
  if (candidates.length <= 1) return candidates[0];
  const sorted = [...candidates].sort((a, b) => a.id - b.id);
  const sap = clean(sapCode);
  if (sap) {
    const sameStateSap = sorted.find((p) => clean(productSapForState(p, state)) === sap);
    if (sameStateSap) return sameStateSap;
    const anySap = sorted.find((p) => [p.gjSap, p.mpSap, p.upSap, p.sapCode].some((v) => clean(v) === sap));
    if (anySap) return anySap;
  }
  const hasStateSap = sorted.filter((p) => !!productSapForState(p, state));
  const pool2 = hasStateSap.length > 0 ? hasStateSap : sorted;
  const byCategory = pool2.find((p) => categoryFitsState(p.category, state));
  return byCategory ?? pool2[0];
}

export async function findProductForLine(
  barcode: string | null | undefined,
  sapCode: string | null | undefined,
  plant: string | null | undefined,
): Promise<Product | undefined> {
  const bc = String(barcode ?? '').trim();
  if (!bc) return undefined;
  const candidates = await db.select().from(productsTable).where(eq(productsTable.barcode, bc));
  if (candidates.length <= 1) return candidates[0];
  return chooseProductForLine(candidates, sapCode, await stateOfPlant(plant));
}

// Every Product Master product that carries this barcode (more than one = a shared barcode), lowest id first.
export async function productsWithBarcode(barcode: string | null | undefined): Promise<Product[]> {
  const bc = String(barcode ?? '').trim();
  if (!bc) return [];
  const rows = await db.select().from(productsTable).where(eq(productsTable.barcode, bc));
  return rows.sort((a, b) => a.id - b.id);
}
