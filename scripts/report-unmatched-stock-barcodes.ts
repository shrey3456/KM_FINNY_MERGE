// scripts/report-unmatched-stock-barcodes.ts
//
// Read-only report: lists every product_plant_stock row whose barcode does not resolve to any
// row in Product Master — either because product_id is missing/stale (points at a product that
// no longer exists), and the barcode text itself also doesn't exactly match anything in
// Product Master. These are the rows that show up on the Stock page with a blank SAP code and
// the raw barcode as the item name (e.g. Valsad's "A1" vs Product Master's "A01").
//
// This script makes NO changes to the database — it only prints a report so you can decide,
// row by row, whether to fix the source order's barcode or remove the bad row. Run it with:
//   npx tsx scripts/report-unmatched-stock-barcodes.ts
import { Pool } from "pg";
import { config } from "dotenv";
config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT
        pps.id, pps.barcode, pps.plant, pps.in_stock AS "inStock", pps.extra_qty AS "extraQty",
        pps.product_id AS "productId",
        p.id AS "resolvedById",
        p_bc.id AS "resolvedByBarcode"
      FROM product_plant_stock pps
      LEFT JOIN products p    ON p.id = pps.product_id
      LEFT JOIN products p_bc ON p.id IS NULL AND LOWER(TRIM(p_bc.barcode)) = LOWER(TRIM(pps.barcode))
      WHERE p.id IS NULL AND p_bc.id IS NULL
      ORDER BY pps.plant, pps.barcode
    `);

    if (rows.length === 0) {
      console.log("No unmatched stock rows found — every product_plant_stock row resolves to a Product Master row.");
      return;
    }

    console.log(`Found ${rows.length} stock row(s) that don't match anything in Product Master:\n`);
    let totalStock = 0;
    let totalExtra = 0;
    for (const r of rows) {
      totalStock += Number(r.inStock ?? 0);
      totalExtra += Number(r.extraQty ?? 0);
      console.log(
        `  plant=${r.plant}  barcode="${r.barcode}"  inStock=${r.inStock}  extraQty=${r.extraQty}` +
        (r.productId ? `  (product_id=${r.productId} — stale, no longer exists in Product Master)` : ""),
      );
    }
    console.log(`\nTotals across all unmatched rows: inStock=${totalStock}, extraQty=${totalExtra}`);
    console.log("\nThis script made no changes. For each row above, either:");
    console.log("  - the source order/CSV has the wrong barcode — go fix it there and re-scan, or");
    console.log("  - the barcode is genuinely missing from Product Master — add it there, or");
    console.log("  - the row is just bad/stale data — delete it via the Stock page's admin delete action.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Report failed:", err);
  process.exit(1);
});
