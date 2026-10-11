import { creditStatePool, type StockPullContribution } from './statePool';

// The Manual Sales screen (Settings) is gone — a day's sales are now created from the Sales Orders file (Proforma Slips >
// Create System Generated Load Slip, or Settings > Load from Sales Orders file). Batches that were created before that still
// exist in manual_sale_* and still count in Stock Overview's Sale; this is the one thing left for them: giving a batch's boxes
// back to the plants they came from and taking it out of Sale. "Load from Sales Orders file" calls it when it replaces a day's
// manual sales (inside its own transaction).
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
