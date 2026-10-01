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

// ── "Recalculate from events only" — a stricter sibling of the ledger-based recalc above. This
// one trusts NOTHING in stock_movements (no Adjust, no Exchange, no Opening Stock, no Clear
// Stock) — it computes stock purely from the three raw scan tables:
//   stock = Order Scan receipts (order_scan_events) + Unloading receipts (unload_scan_events)
//           − Loading dispatches (loading_scan_events)
// Voided rows are excluded everywhere, as always. is_credit rows on order_scan_events/
// unload_scan_events are ALSO excluded — those are system-generated internal reassignments of
// boxes an earlier event already counted (see their own schema comments), not new physical
// stock; counting them too would double the same boxes. This is deliberately narrower than
// recalculateStock(): it will NOT reflect a manual Adjust, an Exchange, or an Opening Stock
// import — only what the three operational scan flows themselves recorded.
async function findPlantCorrectionsFromEvents(q: Queryable): Promise<PlantCorrectionRow[]> {
  const { rows } = await q.query(`
    WITH scan_in AS (
      SELECT LOWER(TRIM(e.barcode)) AS bkey, LOWER(TRIM(s.plant)) AS pkey, MIN(e.barcode) AS barcode, MIN(s.plant) AS plant,
             SUM(e.total_qty)::int AS qty
      FROM order_scan_events e
      JOIN order_import_sessions s ON s.id = e.session_id
      WHERE e.voided IS NOT TRUE AND COALESCE(e.is_credit, false) = false AND s.plant IS NOT NULL
      GROUP BY 1, 2
    ),
    unload_in AS (
      SELECT LOWER(TRIM(barcode)) AS bkey, LOWER(TRIM(plant)) AS pkey, MIN(barcode) AS barcode, MIN(plant) AS plant,
             SUM(total_qty)::int AS qty
      FROM unload_scan_events
      WHERE voided IS NOT TRUE AND COALESCE(is_credit, false) = false AND plant IS NOT NULL
      GROUP BY 1, 2
    ),
    load_out AS (
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
    keys AS (
      SELECT bkey, pkey FROM scan_in UNION SELECT bkey, pkey FROM unload_in
      UNION SELECT bkey, pkey FROM load_out UNION SELECT bkey, pkey FROM stored
    ),
    calc AS (
      SELECT k.bkey, k.pkey,
             COALESCE(s.barcode, si.barcode, u.barcode, l.barcode) AS barcode,
             COALESCE(s.plant, si.plant, u.plant, l.plant) AS plant,
             s.product_id, s.keep_id,
             COALESCE(s.n, 0) AS stored_rows,
             COALESCE(s.stock, 0) AS stored_stock,
             COALESCE(s.extra, 0) AS stored_extra,
             COALESCE(si.qty, 0) + COALESCE(u.qty, 0) - COALESCE(l.qty, 0) AS correct_stock
      FROM keys k
      LEFT JOIN scan_in si ON si.bkey = k.bkey AND si.pkey = k.pkey
      LEFT JOIN unload_in u ON u.bkey = k.bkey AND u.pkey = k.pkey
      LEFT JOIN load_out l ON l.bkey = k.bkey AND l.pkey = k.pkey
      LEFT JOIN stored s ON s.bkey = k.bkey AND s.pkey = k.pkey
    )
    SELECT c.bkey, c.pkey, c.barcode, c.plant, c.product_id AS "productId", c.keep_id AS "keepId",
           c.stored_rows AS "storedRows", c.stored_stock AS "storedStock", c.stored_extra AS "storedExtra",
           c.correct_stock AS "correctStock",
           LEAST(GREATEST(c.stored_extra, 0), GREATEST(c.correct_stock, 0)) AS "correctExtra",
           (SELECT pr.name FROM products pr WHERE LOWER(TRIM(pr.barcode)) = c.bkey LIMIT 1) AS "itemName"
    FROM calc c
    WHERE (c.stored_stock <> c.correct_stock OR c.stored_rows > 1)
      AND NOT (c.stored_rows = 0 AND c.correct_stock = 0)
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

async function findProductCorrectionsFromEvents(q: Queryable): Promise<ProductTotalCorrection[]> {
  const { rows } = await q.query(`
    WITH scan_in AS (
      SELECT LOWER(TRIM(e.barcode)) AS bkey, SUM(e.total_qty)::int AS qty
      FROM order_scan_events e
      WHERE e.voided IS NOT TRUE AND COALESCE(e.is_credit, false) = false
      GROUP BY 1
    ),
    unload_in AS (
      SELECT LOWER(TRIM(barcode)) AS bkey, SUM(total_qty)::int AS qty
      FROM unload_scan_events
      WHERE voided IS NOT TRUE AND COALESCE(is_credit, false) = false
      GROUP BY 1
    ),
    load_out AS (
      SELECT LOWER(TRIM(barcode)) AS bkey, SUM(total_qty)::int AS qty
      FROM loading_scan_events
      WHERE voided IS NOT TRUE AND barcode IS NOT NULL AND plant IS NOT NULL
      GROUP BY 1
    )
    SELECT p.id AS "productId", p.barcode, p.name AS "itemName",
           COALESCE(p.in_stock, 0)::int AS "storedTotal",
           (COALESCE(si.qty, 0) + COALESCE(u.qty, 0) - COALESCE(l.qty, 0))::int AS "correctTotal"
    FROM products p
    LEFT JOIN scan_in si ON si.bkey = LOWER(TRIM(p.barcode))
    LEFT JOIN unload_in u ON u.bkey = LOWER(TRIM(p.barcode))
    LEFT JOIN load_out l ON l.bkey = LOWER(TRIM(p.barcode))
    WHERE p.barcode IS NOT NULL AND TRIM(p.barcode) <> ''
      AND COALESCE(p.in_stock, 0) <> COALESCE(si.qty, 0) + COALESCE(u.qty, 0) - COALESCE(l.qty, 0)
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

// Read-only check — what Apply would change, computed purely from Scan/Unload/Load events.
export async function checkStockFromEvents(q: Queryable): Promise<{ plantRows: PlantStockCorrection[]; productRows: ProductTotalCorrection[] }> {
  const [plantRows, productRows] = await Promise.all([findPlantCorrectionsFromEvents(q), findProductCorrectionsFromEvents(q)]);
  return {
    plantRows: plantRows.map(({ bkey, pkey, keepId, productId, ...row }) => row),
    productRows,
  };
}

// Same transaction/locking shape as recalculateStock() above, sourced from events only. Never
// touches stock_movements (nothing here needs tagging — it doesn't read that table at all).
// Backfills stock_movements so Overall Stock's Opening/Purchase/Adjust/Sale (which read ONLY
// from this ledger, never from product_plant_stock) stop reading as 0 for a barcode+plant whose
// real activity is sitting entirely in the raw event tables with no matching ledger row at all
// — the exact gap recalculateStockFromEvents() above fixes for the LIVE number but, by design,
// never writes anywhere. One reconciliation row per (barcode, plant, source) gap, dated at that
// group's EARLIEST real event (so it lands in the correct Opening-vs-Purchase period bucket in
// the common case, rather than always "today"), tagged origin='events-backfill' so it's always
// identifiable later — never silently indistinguishable from a real scan's own ledger row.
type LedgerGapRow = { barcode: string; plant: string; earliestAt: string; gap: number; productId: number | null; sessionId: number | null };

// Order Scan and Unloading gaps are found PER SESSION (order_import_sessions.id /
// unload_import_sessions.id) — the exact same unit a real scan/unload completion writes its own
// ledger row against (see applyLiveScanStock/applySessionStock in orderGroupReport.ts; Unloading's
// own completion write). One backfilled row per missing session, dated at that session's own
// earliest real event. Loading has no equivalent session id on stock_movements, so it falls back
// to per-calendar-day grouping (the same `created_at::date` granularity Overall Stock's own
// Opening/Purchase split already uses).
//
// This matters because a lifetime-lump gap (the first version of this tool) has to be dated
// SOMEWHERE, and backdating one giant total to the earliest-ever event pulls activity that really
// happened during the report period back into Opening (or the reverse) — the "opening value wrong"
// bug. Per-session/per-day gaps land each missing row in the same bucket its real event was in.

const SCAN_BACKFILL_REASON = 'Backfilled from Order Scan events (ledger reconciliation)';
const UNLOAD_BACKFILL_REASON = 'Backfilled from Unloading events (ledger reconciliation)';
const LOAD_BACKFILL_REASON = 'Backfilled from Loading events (ledger reconciliation)';

// Order Scan receipts — stock_movements rows from this source have no 'source' tag at all
// (see applyLiveScanStock/applySessionStock in orderGroupReport.ts).
async function findScanLedgerGaps(q: Queryable): Promise<LedgerGapRow[]> {
  const { rows } = await q.query(`
    WITH raw AS (
      SELECT e.session_id, LOWER(TRIM(e.barcode)) AS bkey,
             MIN(e.barcode) AS barcode, MIN(s.plant) AS plant, SUM(e.total_qty)::int AS qty, MIN(e.scanned_at) AS earliest_at
      FROM order_scan_events e JOIN order_import_sessions s ON s.id = e.session_id
      WHERE e.voided IS NOT TRUE AND COALESCE(e.is_credit, false) = false AND s.plant IS NOT NULL
      GROUP BY 1, 2
    ),
    ledger AS (
      SELECT session_id, LOWER(TRIM(barcode)) AS bkey, SUM(qty)::int AS qty
      FROM stock_movements
      WHERE type = 'receive' AND COALESCE(source, '') <> 'unloading' AND session_id IS NOT NULL
        AND NOT (origin = 'events-backfill' AND reason = '${SCAN_BACKFILL_REASON}')
      GROUP BY 1, 2
    )
    SELECT raw.barcode, raw.plant, raw.earliest_at AS "earliestAt", raw.session_id AS "sessionId",
           (raw.qty - COALESCE(ledger.qty, 0)) AS gap,
           (SELECT id FROM products WHERE LOWER(TRIM(barcode)) = LOWER(TRIM(raw.barcode)) LIMIT 1) AS "productId"
    FROM raw LEFT JOIN ledger ON ledger.session_id = raw.session_id AND ledger.bkey = raw.bkey
    WHERE (raw.qty - COALESCE(ledger.qty, 0)) <> 0
  `);
  return rows.map((r: any) => ({ barcode: r.barcode, plant: r.plant, earliestAt: r.earliestAt, gap: Number(r.gap), productId: r.productId != null ? Number(r.productId) : null, sessionId: r.sessionId != null ? Number(r.sessionId) : null }));
}

async function insertScanLedgerGap(client: Queryable, g: LedgerGapRow): Promise<void> {
  await client.query(
    `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, session_id, created_at, origin)
     VALUES ($1, $2, $3, $4, 0, 'receive', $5, $6, $7, 'events-backfill')`,
    [g.barcode, g.productId, g.plant, g.gap, SCAN_BACKFILL_REASON, g.sessionId, g.earliestAt],
  );
}

async function wipeScanLedgerBackfill(client: Queryable): Promise<void> {
  await client.query(`DELETE FROM stock_movements WHERE origin = 'events-backfill' AND reason = '${SCAN_BACKFILL_REASON}'`);
}

// Unloading receipts — tagged source = 'unloading'.
async function findUnloadLedgerGaps(q: Queryable): Promise<LedgerGapRow[]> {
  const { rows } = await q.query(`
    WITH raw AS (
      SELECT session_id, LOWER(TRIM(barcode)) AS bkey,
             MIN(barcode) AS barcode, MIN(plant) AS plant, SUM(total_qty)::int AS qty, MIN(scanned_at) AS earliest_at
      FROM unload_scan_events
      WHERE voided IS NOT TRUE AND COALESCE(is_credit, false) = false AND plant IS NOT NULL
      GROUP BY 1, 2
    ),
    ledger AS (
      SELECT session_id, LOWER(TRIM(barcode)) AS bkey, SUM(qty)::int AS qty
      FROM stock_movements
      WHERE type = 'receive' AND source = 'unloading' AND session_id IS NOT NULL
        AND NOT (origin = 'events-backfill' AND reason = '${UNLOAD_BACKFILL_REASON}')
      GROUP BY 1, 2
    )
    SELECT raw.barcode, raw.plant, raw.earliest_at AS "earliestAt", raw.session_id AS "sessionId",
           (raw.qty - COALESCE(ledger.qty, 0)) AS gap,
           (SELECT id FROM products WHERE LOWER(TRIM(barcode)) = LOWER(TRIM(raw.barcode)) LIMIT 1) AS "productId"
    FROM raw LEFT JOIN ledger ON ledger.session_id = raw.session_id AND ledger.bkey = raw.bkey
    WHERE (raw.qty - COALESCE(ledger.qty, 0)) <> 0
  `);
  return rows.map((r: any) => ({ barcode: r.barcode, plant: r.plant, earliestAt: r.earliestAt, gap: Number(r.gap), productId: r.productId != null ? Number(r.productId) : null, sessionId: r.sessionId != null ? Number(r.sessionId) : null }));
}

async function insertUnloadLedgerGap(client: Queryable, g: LedgerGapRow): Promise<void> {
  await client.query(
    `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, source, session_id, created_at, origin)
     VALUES ($1, $2, $3, $4, 0, 'receive', $5, 'unloading', $6, $7, 'events-backfill')`,
    [g.barcode, g.productId, g.plant, g.gap, UNLOAD_BACKFILL_REASON, g.sessionId, g.earliestAt],
  );
}

async function wipeUnloadLedgerBackfill(client: Queryable): Promise<void> {
  await client.query(`DELETE FROM stock_movements WHERE origin = 'events-backfill' AND reason = '${UNLOAD_BACKFILL_REASON}'`);
}

// Loading dispatches — always negative (stock leaving). Compared against the ledger's own
// 'dispatch' rows regardless of source tag, since Loading consistently tags source='loading'.
async function findLoadLedgerGaps(q: Queryable): Promise<LedgerGapRow[]> {
  const { rows } = await q.query(`
    WITH raw AS (
      SELECT LOWER(TRIM(barcode)) AS bkey, LOWER(TRIM(plant)) AS pkey, scanned_at::date AS d,
             MIN(barcode) AS barcode, MIN(plant) AS plant, SUM(total_qty)::int AS qty, MIN(scanned_at) AS earliest_at
      FROM loading_scan_events
      WHERE voided IS NOT TRUE AND barcode IS NOT NULL AND plant IS NOT NULL
      GROUP BY 1, 2, 3
    ),
    ledger AS (
      SELECT LOWER(TRIM(barcode)) AS bkey, LOWER(TRIM(plant)) AS pkey, created_at::date AS d, SUM(-qty)::int AS qty
      FROM stock_movements
      WHERE type = 'dispatch'
        AND NOT (origin = 'events-backfill' AND reason = '${LOAD_BACKFILL_REASON}')
      GROUP BY 1, 2, 3
    )
    SELECT raw.barcode, raw.plant, raw.earliest_at AS "earliestAt", (raw.qty - COALESCE(ledger.qty, 0)) AS gap,
           (SELECT id FROM products WHERE LOWER(TRIM(barcode)) = LOWER(TRIM(raw.barcode)) LIMIT 1) AS "productId"
    FROM raw LEFT JOIN ledger ON ledger.bkey = raw.bkey AND ledger.pkey = raw.pkey AND ledger.d = raw.d
    WHERE (raw.qty - COALESCE(ledger.qty, 0)) <> 0
  `);
  return rows.map((r: any) => ({ barcode: r.barcode, plant: r.plant, earliestAt: r.earliestAt, gap: Number(r.gap), productId: r.productId != null ? Number(r.productId) : null, sessionId: null }));
}

async function insertLoadLedgerGap(client: Queryable, g: LedgerGapRow): Promise<void> {
  await client.query(
    `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, source, created_at, origin)
     VALUES ($1, $2, $3, $4, 0, 'dispatch', $5, 'loading', $6, 'events-backfill')`,
    [g.barcode, g.productId, g.plant, -g.gap, LOAD_BACKFILL_REASON, g.earliestAt],
  );
}

async function wipeLoadLedgerBackfill(client: Queryable): Promise<void> {
  await client.query(`DELETE FROM stock_movements WHERE origin = 'events-backfill' AND reason = '${LOAD_BACKFILL_REASON}'`);
}

// Wipes this tool's OWN previous writes before every run (never anything else, matched by the
// exact origin+reason it itself wrote) so a stale, wrongly-dated row from an earlier version of
// this logic can never coexist with — and double-count against — today's corrected one. Always
// safe: these rows are pure reconciliation, fully re-derivable from the raw events every time.
async function backfillLedgerFromEvents(client: Queryable): Promise<number> {
  await wipeScanLedgerBackfill(client);
  await wipeUnloadLedgerBackfill(client);
  await wipeLoadLedgerBackfill(client);
  let written = 0;
  for (const g of await findScanLedgerGaps(client)) { await insertScanLedgerGap(client, g); written++; }
  for (const g of await findUnloadLedgerGaps(client)) { await insertUnloadLedgerGap(client, g); written++; }
  for (const g of await findLoadLedgerGaps(client)) { await insertLoadLedgerGap(client, g); written++; }
  return written;
}

// Standalone "Fill Stock Ledger (from Scan + Unload + Load events)" button (Settings > Data
// Management). Same gap logic backfillLedgerFromEvents() uses (one row per missing Scan/Unload
// session, one per missing Loading day), as its own button — it never touches
// product_plant_stock/products, purely a stock_movements reconciliation so Overall Stock's
// Opening/Purchase (which read only the ledger) stop showing 0 for a barcode+plant whose real
// activity has no matching ledger row at all, even when the live stock number is already correct
// and the user doesn't want it touched again.
export async function checkStockLedgerBackfill(q: Queryable): Promise<{ scanGaps: LedgerGapRow[]; unloadGaps: LedgerGapRow[]; loadGaps: LedgerGapRow[]; totalGapQty: number }> {
  const [scanGaps, unloadGaps, loadGaps] = await Promise.all([findScanLedgerGaps(q), findUnloadLedgerGaps(q), findLoadLedgerGaps(q)]);
  const totalGapQty = [...scanGaps, ...unloadGaps, ...loadGaps].reduce((sum, g) => sum + Math.abs(g.gap), 0);
  return { scanGaps, unloadGaps, loadGaps, totalGapQty };
}

export async function applyStockLedgerBackfill(pool: Pool): Promise<{ written: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '10s'`);
    try {
      await client.query(`LOCK TABLE order_scan_events, unload_scan_events, loading_scan_events, stock_movements IN SHARE ROW EXCLUSIVE MODE`);
    } catch (error: any) {
      if (error?.code === '55P03' || error?.code === '40P01') throw new StockBusyError('Stock is being updated right now — try again in a moment.');
      throw error;
    }
    const written = await backfillLedgerFromEvents(client);
    await client.query('COMMIT');
    return { written };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function recalculateStockFromEvents(pool: Pool): Promise<{
  plantRowsFixed: number;
  duplicateRowsCleared: number;
  productTotalsFixed: number;
  ledgerRowsBackfilled: number;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '10s'`);
    try {
      await client.query(
        `LOCK TABLE order_scan_events, unload_scan_events, loading_scan_events, stock_movements, product_plant_stock, products IN SHARE ROW EXCLUSIVE MODE`,
      );
    } catch (error: any) {
      if (error?.code === '55P03' || error?.code === '40P01') throw new StockBusyError('Stock is being updated right now — try again in a moment.');
      throw error;
    }

    // Backfill the ledger FIRST — the live-stock correction below reads the same raw events
    // (not the ledger), so order doesn't affect its own result, but doing this first means a
    // re-run of the preview/apply pair afterward sees a ledger that already matches, not one
    // that still looks like it needs the same fix again.
    const ledgerRowsBackfilled = await backfillLedgerFromEvents(client);

    const corrections = await findPlantCorrectionsFromEvents(client);

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
      ledgerRowsBackfilled,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
