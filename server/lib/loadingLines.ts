import type { Pool } from 'pg';

// SAME BARCODE, DIFFERENT PRODUCT = DIFFERENT LINES (Loading).
// Two products can share a barcode (the 35 g and the 37 g salted peanuts, one per state), and a slip can list both as two lines. A line is
// told apart by its PRODUCT, not by its barcode: each slip line stores the exact product (proforma_slip_items.product_id) and each loading
// entry now stores the product it was loaded for (loading_scan_events.product_id). Entries made before that column existed have no product;
// they keep counting on the FIRST line of their barcode, exactly as they always did.
//
// Everything here is plain functions on rows already read from the database, so the rules sit in one place:
//   - which lines carry a barcode, and whether that barcode is "shared" (two or more different products on the slip),
//   - which line a loading entry belongs to,
//   - how much is loaded on each line (and on a product that is not a line of the slip at all).

export const ensureLoadingLineSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`ALTER TABLE loading_scan_events ADD COLUMN IF NOT EXISTS product_id INTEGER`);
  await pool.query(`ALTER TABLE unload_scan_events ADD COLUMN IF NOT EXISTS product_id INTEGER`);
};

export type SlipLine = { id: number; barcode: string | null; productId?: number | null; quantity?: number | null };

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

export function linesForBarcode<T extends SlipLine>(lines: T[], barcode: string | null | undefined): T[] {
  const bc = norm(barcode);
  if (!bc) return [];
  return lines.filter((l) => norm(l.barcode) === bc).sort((a, b) => a.id - b.id);
}

// More than one different product on the slip carries this barcode. (Lines with no product id count as one unknown product, so an old slip
// that merely lists a barcode twice keeps behaving as before.)
export function isSharedBarcode(barcodeLines: SlipLine[]): boolean {
  const keys = new Set(barcodeLines.map((l) => (l.productId != null ? `p${l.productId}` : 'x')));
  return keys.size > 1;
}

// The line a loading entry (with this product, or none) belongs to. null = it belongs to no line of the slip: a product that shares the
// barcode with a line but is not itself on the slip (an Extra for the twin).
export function lineForEvent<T extends SlipLine>(barcodeLines: T[], eventProductId: number | null | undefined): T | null {
  if (barcodeLines.length === 0) return null;
  if (eventProductId == null) return barcodeLines[0];                       // an older entry: the first line, as always
  const exact = barcodeLines.find((l) => l.productId === eventProductId);
  if (exact) return exact;
  // a line with no product id stands for "whatever product this barcode is" — it takes the entry
  if (barcodeLines.every((l) => l.productId == null)) return barcodeLines[0];
  return null;
}

export type EventGroup = { barcode: string; productId: number | null; qty: number };

// Loaded per line, plus what was loaded for products that are not lines of the slip but share a line's barcode.
export function loadedPerLine<T extends SlipLine>(lines: T[], groups: EventGroup[]): { perLine: Map<number, number>; offLineProducts: Array<{ barcode: string; productId: number; qty: number }> } {
  const perLine = new Map<number, number>();
  const off = new Map<string, { barcode: string; productId: number; qty: number }>();
  for (const g of groups) {
    const barcodeLines = linesForBarcode(lines, g.barcode);
    if (barcodeLines.length === 0) continue;                                  // a barcode that is not on the slip at all: handled elsewhere
    const line = lineForEvent(barcodeLines, g.productId);
    if (line) perLine.set(line.id, (perLine.get(line.id) ?? 0) + g.qty);
    else if (g.productId != null) {
      const key = `${norm(g.barcode)}::${g.productId}`;
      const cur = off.get(key) ?? { barcode: g.barcode, productId: g.productId, qty: 0 };
      cur.qty += g.qty;
      off.set(key, cur);
    }
  }
  return { perLine, offLineProducts: Array.from(off.values()) };
}

// Which line a scan / Extra / +/- request is for.
//   - the request names a product (the popup's choice, or the product picked in Add Extra): that product's line, or none when the product is
//     not on the slip (the twin);
//   - no product named: the only line with this barcode;
//   - no product named and more than one line: ambiguous — the caller must ask.
export type LineResolution<T extends SlipLine> =
  | { kind: 'line'; line: T }
  | { kind: 'not-on-slip' }
  | { kind: 'ambiguous'; lines: T[] };

export function resolveLine<T extends SlipLine>(lines: T[], barcode: string | null | undefined, requestedProductId: number | null | undefined): LineResolution<T> {
  const barcodeLines = linesForBarcode(lines, barcode);
  if (barcodeLines.length === 0) return { kind: 'not-on-slip' };
  if (requestedProductId != null) {
    const exact = barcodeLines.find((l) => l.productId === requestedProductId);
    if (exact) return { kind: 'line', line: exact };
    // a barcode with a single line that has no product id: that line, whatever product was named
    if (barcodeLines.every((l) => l.productId == null)) return { kind: 'line', line: barcodeLines[0] };
    return { kind: 'not-on-slip' };
  }
  if (!isSharedBarcode(barcodeLines)) return { kind: 'line', line: barcodeLines[0] };
  return { kind: 'ambiguous', lines: barcodeLines };
}
