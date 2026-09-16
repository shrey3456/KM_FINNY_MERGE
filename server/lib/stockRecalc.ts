import type { Pool } from 'pg';

type Queryable = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

// Recalculate Stock (Settings > Data Management).
//
// The app keeps stock in two places: the HISTORY (every movement in stock_movements, plus what
// Loading actually loaded in loading_scan_events) and the STORED totals (product_plant_stock per
// item + plant, and products.in_stock as the all-plant total). Every page is supposed to update
// both together, but a missed step leaves the stored total wrong while the history is still
// right. This works the stored totals out again from the full history and corrects only those —
// the history, scans, CSVs and proforma slips are never touched.
//
// From the history, per item + plant (the same rules Overall Stock's ledger uses):
//   stock = every non-Loading movement (receiving, unloading, adjustments, exchanges, opening
//           stock, Clear Stock) − everything Loading actually loaded (voids excluded).
//   extra = the history's extra count, kept between 0 and the stock — in_stock already counts
//           extras inside it, so more extra than stock is impossible.
//   products.in_stock = the sum of that barcode's plant stock.

// source = 'loading' / 'unloading' on ledger rows those pages wrote before they tagged their own
// rows. Needed so Loading's stock-out is left out of the purchase side (Sale comes from its scan
// records instead) and Unloading's rows are dated by their own batch. Safe to run repeatedly — it
// only ever touches untagged rows. Matches each writer's reason text.
export async function tagStockMovementSources(q: Queryable): Promise<{ loading: number; unloading: number }> {
  const loading = await q.query(`UPDATE stock_movements SET source = 'loading' WHERE source IS NULL AND (
    type = 'dispatch'
    OR reason LIKE 'Loaded quantity manually %'
    OR reason LIKE 'Loading slip % reset%'
    OR reason LIKE 'Voided load scan for order %'
    OR (reason LIKE 'Qty corrected (edited by %' AND session_id IS NULL))`);
  const unloading = await q.query(`UPDATE stock_movements SET source = 'unloading' WHERE source IS NULL AND session_id IS NOT NULL AND (
    reason LIKE 'Unloaded vehicle %'
    OR reason = 'Unloading CSV deleted — rollback'
    OR reason = 'Unloading scan voided'
    OR reason LIKE 'Qty correction — old scan reversed (edited by %'
    OR reason LIKE 'Qty corrected (edited by %'
    OR reason LIKE 'Barcode correction (unloading edit)%'
    OR reason LIKE 'Quantity correction (unloading edit)%'
    OR EXISTS (SELECT 1 FROM unload_scan_events use WHERE use.session_id = stock_movements.session_id
               AND use.voided AND use.void_reason = stock_movements.reason))`);
  return { loading: loading.rowCount ?? 0, unloading: unloading.rowCount ?? 0 };
}

export type PlantStockCorrection = {
  barcode: string;
  plant: string;
  itemName: string | null;
  storedStock: number;
  storedExtra: number;
  correctStock: number;
  correctExtra: number;
  // More than one stored row for the same item + plant (different spelling/case). The corrected
  // total goes on one row; the others are set to 0.
  storedRows: number;
};

export type ProductTotalCorrection = {
  productId: number;
  barcode: string;
  itemName: string | null;
  storedTotal: number;
  correctTotal: number;
};

type PlantCorrectionRow = PlantStockCorrection & {
  bkey: string;
  pkey: string;
  keepId: number | null;
  productId: number | null;
};

// Every item + plant whose stored numbers differ from the history. Rows with nothing stored and
// nothing in the history are skipped — there's nothing to create for them.
async function findPlantCorrections(q: Queryable): Promise<PlantCorrectionRow[]> {
  const { rows } = await q.query(`
    WITH hist AS (
      SELECT LOWER(TRIM(barcode)) AS bkey, LOWER(TRIM(plant)) AS pkey, MIN(barcode) AS barcode, MIN(plant) AS plant,
             SUM(qty)::int AS stock, SUM(extra_qty)::int AS extra, MAX(product_id) AS product_id
      FROM stock_movements
      WHERE source IS DISTINCT FROM 'loading' AND type <> 'dispatch'
      GROUP BY 1, 2
    ),
    loaded AS (
      SELECT LOWER(TRIM(barcode)) AS bkey, LOWER(TRIM(plant)) AS pkey, MIN(barcode) AS barcode, MIN(plant) AS plant,
             SUM(total_qty)::int AS qty
      FROM loading_scan_events
      WHERE voided IS NOT TRUE AND barcode IS NOT NULL AND plant IS NOT NULL
      GROUP BY 1, 2
    ),
    stored AS (
      SELECT LOWER(TRIM(barcode)) AS bkey, LOWER(TRIM(plant)) AS pkey, MIN(barcode) AS barcode, MIN(plant) AS plant,
             COUNT(*)::int AS n, SUM(in_stock)::int AS stock, SUM(extra_qty)::int AS extra, MIN(id) AS keep_id,
             MAX(product_id) AS product_id
      FROM product_plant_stock
      GROUP BY 1, 2
    ),
    keys AS (SELECT bkey, pkey FROM hist UNION SELECT bkey, pkey FROM loaded UNION SELECT bkey, pkey FROM stored),
    calc AS (
      SELECT k.bkey, k.pkey,
             COALESCE(s.barcode, h.barcode, l.barcode) AS barcode,
             COALESCE(s.plant, h.plant, l.plant) AS plant,
             COALESCE(s.product_id, h.product_id) AS product_id,
             s.keep_id,
             COALESCE(s.n, 0) AS stored_rows,
             COALESCE(s.stock, 0) AS stored_stock,
             COALESCE(s.extra, 0) AS stored_extra,
             COALESCE(h.stock, 0) - COALESCE(l.qty, 0) AS correct_stock,
             LEAST(GREATEST(COALESCE(h.extra, 0), 0), GREATEST(COALESCE(h.stock, 0) - COALESCE(l.qty, 0), 0)) AS correct_extra
      FROM keys k
      LEFT JOIN hist h ON h.bkey = k.bkey AND h.pkey = k.pkey
      LEFT JOIN loaded l ON l.bkey = k.bkey AND l.pkey = k.pkey
      LEFT JOIN stored s ON s.bkey = k.bkey AND s.pkey = k.pkey
    )
    SELECT c.bkey, c.pkey, c.barcode, c.plant, c.product_id AS "productId", c.keep_id AS "keepId",
           c.stored_rows AS "storedRows", c.stored_stock AS "storedStock", c.stored_extra AS "storedExtra",
           c.correct_stock AS "correctStock", c.correct_extra AS "correctExtra",
           (SELECT pr.name FROM products pr WHERE LOWER(TRIM(pr.barcode)) = c.bkey LIMIT 1) AS "itemName"
    FROM calc c
    WHERE (c.stored_stock <> c.correct_stock OR c.stored_extra <> c.correct_extra OR c.stored_rows > 1)
      AND NOT (c.stored_rows = 0 AND c.correct_stock = 0 AND c.correct_extra = 0)
    ORDER BY c.plant, "itemName", c.barcode
  `);
  return rows.map((r: any) => ({
    bkey: r.bkey,
    pkey: r.pkey,
    barcode: r.barcode,
    plant: r.plant,
    itemName: r.itemName ?? null,
    keepId: r.keepId != null ? Number(r.keepId) : null,
    productId: r.productId != null ? Number(r.productId) : null,
    storedRows: Number(r.storedRows),
    storedStock: Number(r.storedStock),
    storedExtra: Number(r.storedExtra),
    correctStock: Number(r.correctStock),
    correctExtra: Number(r.correctExtra),
  }));
}

// Products whose all-plant total differs from the sum of their plant stock as it WILL be once the
// plant rows are corrected — i.e. from the history, not from the (possibly wrong) stored rows.
async function findProductCorrections(q: Queryable): Promise<ProductTotalCorrection[]> {
  const { rows } = await q.query(`
    WITH hist AS (
      SELECT LOWER(TRIM(barcode)) AS bkey, SUM(qty)::int AS stock
      FROM stock_movements
      WHERE source IS DISTINCT FROM 'loading' AND type <> 'dispatch'
      GROUP BY 1
    ),
    loaded AS (
      SELECT LOWER(TRIM(barcode)) AS bkey, SUM(total_qty)::int AS qty
      FROM loading_scan_events
      WHERE voided IS NOT TRUE AND barcode IS NOT NULL AND plant IS NOT NULL
      GROUP BY 1
    )
    SELECT p.id AS "productId", p.barcode, p.name AS "itemName",
           COALESCE(p.in_stock, 0)::int AS "storedTotal",
           (COALESCE(h.stock, 0) - COALESCE(l.qty, 0))::int AS "correctTotal"
    FROM products p
    LEFT JOIN hist h ON h.bkey = LOWER(TRIM(p.barcode))
    LEFT JOIN loaded l ON l.bkey = LOWER(TRIM(p.barcode))
    WHERE p.barcode IS NOT NULL AND TRIM(p.barcode) <> ''
      AND COALESCE(p.in_stock, 0) <> COALESCE(h.stock, 0) - COALESCE(l.qty, 0)
    ORDER BY p.name
  `);
  return rows.map((r: any) => ({
    productId: Number(r.productId),
    barcode: r.barcode,
    itemName: r.itemName ?? null,
    storedTotal: Number(r.storedTotal),
    correctTotal: Number(r.correctTotal),
  }));
}

// Read-only check — what Apply would change.
export async function checkStock(q: Queryable): Promise<{ plantRows: PlantStockCorrection[]; productRows: ProductTotalCorrection[] }> {
  const [plantRows, productRows] = await Promise.all([findPlantCorrections(q), findProductCorrections(q)]);
  return {
    plantRows: plantRows.map(({ bkey, pkey, keepId, productId, ...row }) => row),
    productRows,
  };
}

export class StockBusyError extends Error {}

// Corrects the stored totals from the history in one transaction. Stock writes (scans, loading,
// adjustments) wait while it runs, so nothing changes between reading the history and writing the
// corrected totals; if the tables can't be locked quickly it gives up with StockBusyError instead
// of making the scanning pages wait long.
export async function recalculateStock(pool: Pool): Promise<{
  plantRowsFixed: number;
  duplicateRowsCleared: number;
  productTotalsFixed: number;
  ledgerRowsTagged: number;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '10s'`);
    try {
      await client.query(
        `LOCK TABLE stock_movements, loading_scan_events, product_plant_stock, products IN SHARE ROW EXCLUSIVE MODE`,
      );
    } catch (error: any) {
      if (error?.code === '55P03' || error?.code === '40P01') throw new StockBusyError('Stock is being updated right now — try again in a moment.');
      throw error;
    }

    const tagged = await tagStockMovementSources(client);
    const corrections = await findPlantCorrections(client);

    let plantRowsFixed = 0;
    let duplicateRowsCleared = 0;
    for (const c of corrections) {
      if (c.keepId != null) {
        await client.query(
          `UPDATE product_plant_stock SET in_stock = $1, extra_qty = $2, updated_at = NOW() WHERE id = $3`,
          [c.correctStock, c.correctExtra, c.keepId],
        );
        if (c.storedRows > 1) {
          const cleared = await client.query(
            `UPDATE product_plant_stock SET in_stock = 0, extra_qty = 0, updated_at = NOW()
             WHERE LOWER(TRIM(barcode)) = $1 AND LOWER(TRIM(plant)) = $2 AND id <> $3`,
            [c.bkey, c.pkey, c.keepId],
          );
          duplicateRowsCleared += cleared.rowCount ?? 0;
        }
      } else {
        await client.query(
          `INSERT INTO product_plant_stock (barcode, product_id, plant, in_stock, extra_qty, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (barcode, plant) DO UPDATE SET in_stock = EXCLUDED.in_stock, extra_qty = EXCLUDED.extra_qty, updated_at = NOW()`,
          [c.barcode, c.productId, c.plant, c.correctStock, c.correctExtra],
        );
      }
      plantRowsFixed += 1;
    }

    // The all-plant total always follows the (now corrected) plant rows.
    const products = await client.query(`
      UPDATE products p
      SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(TRIM(pps.barcode)) = LOWER(TRIM(p.barcode))), 0)
      WHERE p.barcode IS NOT NULL AND TRIM(p.barcode) <> ''
        AND COALESCE(p.in_stock, 0) <> COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(TRIM(pps.barcode)) = LOWER(TRIM(p.barcode))), 0)
    `);

    await client.query('COMMIT');
    return {
      plantRowsFixed,
      duplicateRowsCleared,
      productTotalsFixed: products.rowCount ?? 0,
      ledgerRowsTagged: tagged.loading + tagged.unloading,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
