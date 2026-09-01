import type { PoolClient, Pool } from 'pg';

// product_plant_stock rows are keyed by (barcode, plant), not by the product's stable id — see
// productId's own comment in shared/schema.ts. That's fine as long as a product's barcode never
// changes, but it CAN change (most commonly the Notion inventory sync, which matches existing
// products by their stable Notion page id and overwrites barcode when it differs). When that
// happens, any stock already recorded under the OLD barcode is silently stranded: the next scan
// under the NEW barcode creates a second, separate product_plant_stock row instead of adding to
// the existing pile, and the two never combine on their own.
//
// This is the fix, called two ways:
//   - Lazily, right before every stock-affecting write (Order Scan/Loading/Unloading/Opening
//     Stock) once the barcode has been resolved to a product: "does this product already have a
//     plant-stock row parked under some OTHER (stale) barcode? If so, fold it into the row for
//     the current barcode before proceeding" — so the very next scan after a barcode change
//     self-heals the split instead of creating a permanent second pile.
//   - Eagerly, from the Notion inventory sync itself the moment it detects a product's barcode
//     changed, so the merge happens immediately rather than waiting for the next scan.
// Either way, only the CURRENT balance table (product_plant_stock) is touched — stock_movements
// stays exactly as history recorded it; this never changes a real quantity, only relabels/merges
// rows that already refer to the same physical product.
export async function reconcileProductPlantStockBarcode(
  client: PoolClient | Pool,
  productId: number | null | undefined,
  plant: string | null | undefined,
  currentBarcode: string | null | undefined,
): Promise<void> {
  if (!productId || !plant || !currentBarcode) return;

  const { rows: staleRows } = await client.query(
    `SELECT id, barcode, in_stock, extra_qty FROM product_plant_stock
     WHERE product_id = $1 AND plant = $2 AND barcode <> $3
     FOR UPDATE`,
    [productId, plant, currentBarcode],
  );
  if (staleRows.length === 0) return;

  const { rows: targetRows } = await client.query(
    `SELECT id FROM product_plant_stock WHERE barcode = $1 AND plant = $2 FOR UPDATE`,
    [currentBarcode, plant],
  );
  let targetId: number | null = targetRows[0]?.id ?? null;

  for (const stale of staleRows) {
    if (targetId) {
      // A row already exists under the current barcode — fold the stale row's quantities into
      // it (a straight sum; nothing is created or destroyed) and remove the now-empty stale row.
      await client.query(
        `UPDATE product_plant_stock SET in_stock = in_stock + $1, extra_qty = extra_qty + $2, updated_at = NOW() WHERE id = $3`,
        [stale.in_stock, stale.extra_qty, targetId],
      );
      await client.query(`DELETE FROM product_plant_stock WHERE id = $1`, [stale.id]);
    } else {
      // No row yet under the current barcode — simplest case, just relabel the stale one. It
      // becomes the target for any further stale rows found in this same pass.
      await client.query(
        `UPDATE product_plant_stock SET barcode = $1, updated_at = NOW() WHERE id = $2`,
        [currentBarcode, stale.id],
      );
      targetId = stale.id;
    }
  }
}
