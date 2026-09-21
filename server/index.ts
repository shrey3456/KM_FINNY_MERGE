import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { pool } from "./db";
import { tagStockMovementSources } from './lib/stockRecalc';


const app = express();
app.set("trust proxy", 1);

// Add CORS and security headers for deployment
app.use((req, res, next) => {
  // Allow credentials for authentication
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Set security headers for deployment
  if (process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === '1') {
    res.header('X-Frame-Options', 'SAMEORIGIN');
    res.header('X-Content-Type-Options', 'nosniff');
  }
  
  next();
});

app.use(express.json({
  limit: '10mb',
  // Notion signs the exact bytes of each webhook request, so keep them for that one route
  // (checked in server/routes/notion-webhook.ts). Every other route is unaffected.
  verify: (req, _res, buf) => {
    if ((req as any).originalUrl?.startsWith('/api/webhooks/notion')) (req as any).rawBody = Buffer.from(buf);
  },
}));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});


(async () => {

  // Initialize database and run migrations
  console.log('Initializing database...');

  // Run migrations
  try {
    await pool.query(`
      ALTER TABLE order_scan_events
      ADD COLUMN IF NOT EXISTS notion_synced_at TIMESTAMP WITH TIME ZONE
    `);
    await pool.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS product_image_hash TEXT
    `);
    await pool.query(`
      ALTER TABLE plants
      ADD COLUMN IF NOT EXISTS is_auto_complete_enabled BOOLEAN DEFAULT false
    `);
    await pool.query(`
      ALTER TABLE plants
      ADD COLUMN IF NOT EXISTS is_auto_scan_enabled BOOLEAN DEFAULT false
    `);
    await pool.query(`
      ALTER TABLE order_scan_events
      ADD COLUMN IF NOT EXISTS credited_qty INTEGER DEFAULT 0
    `);
    // Flags a row as a system-generated credit transfer (see reconcileCredits) rather than a
    // real scan, and points it back at the source Extra event it was transferred from — so
    // voiding it can skip the stock reversal and give the qty back to the source instead of
    // double-removing real stock.
    await pool.query(`
      ALTER TABLE order_scan_events
      ADD COLUMN IF NOT EXISTS is_credit BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS credit_source_event_id INTEGER
    `);
    // (Empty Box entries reuse order_scan_events' existing columns — sentinel barcode
    // 'EMPTY_BOX', count in total_qty, note in item_name — so no schema change is needed.)

    // Short state code (e.g. "GJ", "MP") for the Indian state a plant is in — drives which
    // per-state pallet-size column on products (gj_plt/mp_plt) a scan against that plant reads.
    await pool.query(`
      ALTER TABLE plants
      ADD COLUMN IF NOT EXISTS state TEXT
    `);
    // Pallet size moves from being named after the PLANT (ind_plt/val_plt) to the STATE it's
    // actually a fact about (gj_plt/mp_plt) — see plants.state above. A plain rename keeps all
    // existing data; wrapped in a conditional since RENAME COLUMN has no IF EXISTS clause and
    // this needs to be safe to run again on every server start once already applied.
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'ind_plt')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'mp_plt') THEN
          ALTER TABLE products RENAME COLUMN ind_plt TO mp_plt;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'val_plt')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'gj_plt') THEN
          ALTER TABLE products RENAME COLUMN val_plt TO gj_plt;
        END IF;
      END $$;
    `);

    // Order Date is now mandatory on upload and is what Master View scopes by (it replaced the
    // old created_at/upload-day filter). Rows imported before that change can have a NULL
    // order_date and would otherwise drop out of Master View entirely — backfill them from the
    // day they were uploaded, which is what the old filter used anyway, so their behavior is
    // preserved exactly. One-time and idempotent (only touches NULLs).
    await pool.query(`
      UPDATE order_import_sessions
      SET order_date = TO_CHAR(created_at, 'YYYY-MM-DD')
      WHERE order_date IS NULL
    `);
     // Delete-with-rollback for order-import CSVs: tracks who deleted a session and links a
    // deleted session to whichever replacement CSV later carried its scan history forward.
    await pool.query(`
      ALTER TABLE order_import_sessions
      ADD COLUMN IF NOT EXISTS deleted_by_code TEXT,
      ADD COLUMN IF NOT EXISTS remapped_to_session_id INTEGER,
      ADD COLUMN IF NOT EXISTS remapped_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS replaces_session_id INTEGER
    `);
    // Remembers the last scan-history → Notion upload target + column selection so the 30-min
    // auto-sync (runAutoScanHistorySync) can reuse them. Single-row table (id is always 1).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scan_history_notion_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        page_id TEXT,
        columns JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Server-side switch for the Notion product-inventory sync: whether the 24-hour scheduled
    // job (server/routes.ts) is allowed to auto-apply detected changes on its own, or must only
    // detect and leave them pending for an admin to review. Single-row table (id is always 1),
    // off by default so a fresh install never silently writes to the product DB unattended.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notion_inventory_sync_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        auto_apply_enabled BOOLEAN NOT NULL DEFAULT false,
        updated_by TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Same role as notion_inventory_sync_config above, for the Vehicle Master Notion sync
    // (server/services/notionVehicleSync.ts) — kept as its own row/table rather than sharing
    // the product one, since the two syncs are independent and shouldn't share an on/off switch.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notion_vehicle_sync_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        auto_apply_enabled BOOLEAN NOT NULL DEFAULT false,
        updated_by TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // History log for the Loading page (server/routes/loading.ts) — one row per completed
    // vehicle-link action, scoped per-user unless admin/super-admin (see requirePageAccess
    // ('loading') + the createdByCode filter in listLoadingRecords).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loading_records (
        id SERIAL PRIMARY KEY,
        order_number TEXT NOT NULL,
        proforma_slip_id INTEGER,
        party_name TEXT,
        plant TEXT,
        vehicle_number TEXT NOT NULL,
        rto_number TEXT,
        volume TEXT,
        created_by_code TEXT REFERENCES users(user_code),
        created_by_name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Per-scan audit trail for Loading's item-loading step — see loadingScanEvents' comment in
    // shared/schema.ts. Each confirmed row here is what actually decrements product_plant_stock.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loading_scan_events (
        id SERIAL PRIMARY KEY,
        order_number TEXT NOT NULL,
        proforma_slip_id INTEGER,
        barcode TEXT NOT NULL,
        item_name TEXT,
        sap_code TEXT,
        pallets REAL DEFAULT 0,
        loose_qty INTEGER DEFAULT 0,
        total_qty INTEGER DEFAULT 0,
        is_extra BOOLEAN DEFAULT false,
        plant TEXT,
        scanned_by_code TEXT REFERENCES users(user_code),
        scanned_by_name TEXT,
        scanned_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Void support for loading_scan_events (server/routes/loading.ts's POST /events/:id/void) —
    // same voided/voidedByCode/voidedAt/voidReason shape as order_scan_events.
    await pool.query(`
      ALTER TABLE loading_scan_events
        ADD COLUMN IF NOT EXISTS voided BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS voided_by_code TEXT REFERENCES users(user_code),
        ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS void_reason TEXT
    `);
    // Unloading (server/routes/unloading.ts) — vehicle-wise receiving. See unloadImportSessions'
    // comment in shared/schema.ts: FIFO grouping like order_import_sessions, but scoped one level
    // deeper by vehicleNumber (plant + vehicleNumber + orderDate), so one CSV upload can span
    // several vehicles and every vehicle+date group tracks its own active part independently.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS unload_import_sessions (
        id SERIAL PRIMARY KEY,
        plant TEXT NOT NULL,
        vehicle_number TEXT NOT NULL,
        order_date TEXT NOT NULL,
        csv_file_name TEXT NOT NULL,
        row_count INTEGER DEFAULT 0,
        imported_by_code TEXT REFERENCES users(user_code),
        created_at TIMESTAMP DEFAULT NOW(),
        group_id INTEGER,
        part_index INTEGER DEFAULT 1,
        scan_status TEXT DEFAULT 'available',
        scan_activated_by_code TEXT REFERENCES users(user_code),
        scan_activated_at TIMESTAMP,
        scan_completed_by_code TEXT REFERENCES users(user_code),
        scan_completed_at TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS unload_import_items (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES unload_import_sessions(id) ON DELETE CASCADE,
        plant TEXT,
        vehicle_number TEXT,
        barcode TEXT,
        item_name TEXT,
        sap_code TEXT,
        quantity INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS unload_scan_events (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES unload_import_sessions(id) ON DELETE CASCADE,
        barcode TEXT NOT NULL,
        item_name TEXT,
        sap_code TEXT,
        pallets REAL DEFAULT 0,
        loose_qty INTEGER DEFAULT 0,
        total_qty INTEGER DEFAULT 0,
        is_extra BOOLEAN DEFAULT false,
        plant TEXT,
        vehicle_number TEXT,
        scanned_by_code TEXT REFERENCES users(user_code),
        scanned_by_name TEXT,
        scanned_at TIMESTAMP DEFAULT NOW(),
        voided BOOLEAN DEFAULT false,
        voided_by_code TEXT REFERENCES users(user_code),
        voided_at TIMESTAMP,
        void_reason TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_unload_import_sessions_group ON unload_import_sessions(group_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_unload_import_items_session ON unload_import_items(session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_unload_scan_events_session ON unload_scan_events(session_id)`);
    // Delete-with-rollback replacement flow for Unloading — same shape as order_import_sessions'
    // own isDeleted/remappedToSessionId/replacesSessionId columns (see their comment there).
    await pool.query(`
      ALTER TABLE unload_import_sessions
        ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false NOT NULL,
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS deleted_by_code TEXT REFERENCES users(user_code),
        ADD COLUMN IF NOT EXISTS remapped_to_session_id INTEGER,
        ADD COLUMN IF NOT EXISTS remapped_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS replaces_session_id INTEGER
    `);
    // Cross-part credit reconciliation for Unloading — same shape as order_scan_events' own
    // isCredit/creditedQty/creditSourceEventId columns (see their comment there).
    await pool.query(`
      ALTER TABLE unload_scan_events
        ADD COLUMN IF NOT EXISTS is_credit BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS credited_qty INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS credit_source_event_id INTEGER
    `);
    // STV (sub-transfer voucher) per scan — same per-plant STV concept Order Scan already
    // records (order_scan_events.stv, backed by plant_stvs).
    await pool.query(`ALTER TABLE unload_scan_events ADD COLUMN IF NOT EXISTS stv TEXT`);

    // Single-row admin-editable settings (see shared/schema.ts's salesSettings comment) — starts
    // with just the Sales tracking start date, previously a hardcoded constant. Seeded with that
    // same default so behavior doesn't change until an admin edits it on the Settings page.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales_settings (
        id SERIAL PRIMARY KEY,
        sales_tracking_start_date TEXT NOT NULL DEFAULT '2026-08-01',
        updated_at TIMESTAMP DEFAULT NOW(),
        updated_by_code TEXT REFERENCES users(user_code)
      )
    `);
    await pool.query(`INSERT INTO sales_settings (sales_tracking_start_date) SELECT '2026-08-01' WHERE NOT EXISTS (SELECT 1 FROM sales_settings)`);

    // Loading-completion state lives directly on the slip (loadingCompletedAt/By), same pattern
    // as the existing print-lock fields (isPrintLocked/printedByCode/printedAt) on this table.
    await pool.query(`
      ALTER TABLE proforma_slips
        ADD COLUMN IF NOT EXISTS loading_completed_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS loading_completed_by_code TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_assigned_by_code TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_info_id INTEGER
    `);
    // Barcode text is compared across many tables (product name resolution, stock keys, the
    // product_id backfill right below) using LOWER() — a barcode stored with stray leading/
    // trailing whitespace (an old CSV export padded to a fixed width, a pre-fix Notion sync
    // row, a barcode-gun double-fire captured before the trim-at-write fixes in storage.ts/
    // order-scan.ts/loading.ts/unloading.ts existed) silently fails every one of those matches,
    // and Overall Stock/Scan History fall back to showing the bare barcode instead of the
    // resolved item name. Cleaned up once here, idempotently (WHERE barcode <> TRIM(barcode)
    // is a no-op once everything's clean) — every write from here on is already trimmed at the
    // source, so this can't reaccumulate.
    await pool.query(`UPDATE products SET barcode = TRIM(barcode) WHERE barcode <> TRIM(barcode)`);
    // stock_movements.source — marks a person's manual Overall Stock adjustment ('manual'), the
    // only 'adjust' rows Scan History lists. Earlier manual edits that kept the default reason
    // are backfilled; ones given a custom reason can't be told apart and stay untagged.
    await pool.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS source TEXT`);
    await pool.query(`UPDATE stock_movements SET source = 'manual' WHERE type = 'adjust' AND source IS NULL AND reason = 'Manual adjustment (Overall Stock)'`);
    // Tag older Loading / Unloading ledger rows (see server/lib/stockRecalc.ts) — the same
    // function Settings > Recalculate Stock runs.
    await tagStockMovementSources(pool);
    // loading_scan_events.is_adjust — marks the Loading Items table's +/- corrections ("Loading
    // Adjust"). Older ones are found through the stock ledger row the same request wrote (same
    // order, barcode, plant, opposite qty, within a few seconds); a negative qty is always one.
    await pool.query(`ALTER TABLE loading_scan_events ADD COLUMN IF NOT EXISTS is_adjust BOOLEAN DEFAULT false`);
    // proforma_slips.notion_store_keeper_push — which loads push StoreKeeper Info to Notion (see
    // shared/schema.ts). Defaults false, so every slip that exists today is left alone.
    await pool.query(`ALTER TABLE proforma_slips ADD COLUMN IF NOT EXISTS notion_store_keeper_push BOOLEAN DEFAULT false`);
    // proforma_slips.status_before_loading — restored when a load is deleted (see shared/schema.ts).
    await pool.query(`ALTER TABLE proforma_slips ADD COLUMN IF NOT EXISTS status_before_loading TEXT`);
    // order_import_sessions.scan_completed_by_code — who completed a Scan Order part (see schema).
    await pool.query(`ALTER TABLE order_import_sessions ADD COLUMN IF NOT EXISTS scan_completed_by_code TEXT`);
    // Unloading batches are active only once scanned. Put back any left active by the old
    // "opening = active" behaviour that never had a single scan.
    await pool.query(`
      UPDATE unload_import_sessions s
      SET scan_status = 'available', scan_activated_by_code = NULL, scan_activated_at = NULL
      WHERE s.scan_status = 'active' AND s.is_deleted = false
        AND NOT EXISTS (SELECT 1 FROM unload_scan_events e WHERE e.session_id = s.id)`);
    // Same marker on the two scanning tables, set by their qty-edit endpoints ("Scan Adjust" /
    // "Unload Adjust"). No backfill: an edit leaves nothing behind that identifies it afterwards,
    // so only edits made from now on are marked.
    await pool.query(`ALTER TABLE order_scan_events ADD COLUMN IF NOT EXISTS is_adjust BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE unload_scan_events ADD COLUMN IF NOT EXISTS is_adjust BOOLEAN DEFAULT false`);
    // hidden_in_history — "Remove entry" on the Scan History page, allowed only on a row that is
    // already VOIDED or on a stock line written by Settings > Remove All Operations Data (see the
    // endpoint, which re-checks that rule). The row itself is KEPT on purpose: Overall Stock sums
    // its Opening/Purchase/Sale straight out of stock_movements, and a voided scan is what proves
    // the void happened — deleting either would quietly change numbers that are already right.
    // The flag only takes the line out of the Scan History list, and Activities records who did it.
    for (const table of ['order_scan_events', 'loading_scan_events', 'unload_scan_events', 'stock_movements']) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS hidden_in_history BOOLEAN DEFAULT false`);
    }
    await pool.query(`
      UPDATE loading_scan_events lse SET is_adjust = true
      WHERE lse.is_adjust IS NOT TRUE AND (
        lse.total_qty < 0
        OR EXISTS (
          SELECT 1 FROM stock_movements sm
          WHERE sm.type = 'adjust' AND sm.reason LIKE 'Loaded quantity manually %'
            AND sm.reason LIKE '% for order ' || lse.order_number
            AND LOWER(TRIM(sm.barcode)) = LOWER(TRIM(lse.barcode))
            AND LOWER(TRIM(sm.plant)) = LOWER(TRIM(lse.plant))
            AND sm.qty = -lse.total_qty
            AND ABS(EXTRACT(EPOCH FROM (sm.created_at - lse.scanned_at))) < 10
        )
      )`);
    await pool.query(`UPDATE stock_movements SET barcode = TRIM(barcode) WHERE barcode IS NOT NULL AND barcode <> TRIM(barcode)`);
    await pool.query(`UPDATE order_import_items SET barcode = TRIM(barcode) WHERE barcode IS NOT NULL AND barcode <> TRIM(barcode)`);
    await pool.query(`UPDATE order_scan_items SET barcode = TRIM(barcode) WHERE barcode IS NOT NULL AND barcode <> TRIM(barcode)`);
    await pool.query(`UPDATE order_scan_events SET barcode = TRIM(barcode) WHERE barcode IS NOT NULL AND barcode <> TRIM(barcode)`);
    await pool.query(`UPDATE loading_scan_events SET barcode = TRIM(barcode) WHERE barcode IS NOT NULL AND barcode <> TRIM(barcode)`);
    await pool.query(`UPDATE unload_import_items SET barcode = TRIM(barcode) WHERE barcode IS NOT NULL AND barcode <> TRIM(barcode)`);
    await pool.query(`UPDATE unload_scan_events SET barcode = TRIM(barcode) WHERE barcode IS NOT NULL AND barcode <> TRIM(barcode)`);

    // product_plant_stock is UNIQUE(barcode, plant) — unlike the tables above, blindly trimming
    // its barcode can collide with a row that already exists under the trimmed barcode for the
    // same plant. Same merge-or-rename dance as reconcileProductPlantStockBarcode.ts (which
    // handles the equivalent collision for a live barcode edit), run once here for any row still
    // holding a padded barcode from before the trim-at-write fixes existed.
    {
      const { rows: paddedRows } = await pool.query(
        `SELECT id, barcode, plant, in_stock, extra_qty FROM product_plant_stock WHERE barcode <> TRIM(barcode)`
      );
      for (const row of paddedRows) {
        const trimmed = row.barcode.trim();
        const { rows: targetRows } = await pool.query(
          `SELECT id FROM product_plant_stock WHERE barcode = $1 AND plant = $2`,
          [trimmed, row.plant],
        );
        if (targetRows[0]) {
          await pool.query(
            `UPDATE product_plant_stock SET in_stock = in_stock + $1, extra_qty = extra_qty + $2, updated_at = NOW() WHERE id = $3`,
            [row.in_stock, row.extra_qty, targetRows[0].id],
          );
          await pool.query(`DELETE FROM product_plant_stock WHERE id = $1`, [row.id]);
        } else {
          await pool.query(
            `UPDATE product_plant_stock SET barcode = $1, updated_at = NOW() WHERE id = $2`,
            [trimmed, row.id],
          );
        }
      }
    }

    // product_plant_stock/stock_movements previously linked to a product ONLY by barcode text.
    // A product's barcode can be edited later (most commonly via the Notion inventory sync,
    // which matches/updates existing products by their stable Notion page id, not barcode, and
    // overwrites barcode whenever Notion's value differs) — once that happens, stock recorded
    // under the old barcode no longer matches any current product row, and Overall Stock falls
    // back to showing just the bare barcode instead of the item's name/category/etc. product_id
    // is a stable link alongside barcode that survives a later barcode edit. Backfilled from
    // each row's CURRENT barcode below — only fixes rows that haven't drifted yet (nothing
    // remembers what a barcode used to be), but every write from here on populates product_id
    // directly, so this can't happen again going forward. WHERE product_id IS NULL makes this
    // safe to run on every server start — a no-op once everything's backfilled. TRIM() here too,
    // belt-and-braces alongside the cleanup above, in case a row was added between the two.
    await pool.query(`
      ALTER TABLE product_plant_stock
      ADD COLUMN IF NOT EXISTS product_id INTEGER
    `);
    await pool.query(`
      ALTER TABLE stock_movements
      ADD COLUMN IF NOT EXISTS product_id INTEGER
    `);
    await pool.query(`
      UPDATE product_plant_stock pps SET product_id = p.id
      FROM products p
      WHERE pps.product_id IS NULL AND LOWER(TRIM(p.barcode)) = LOWER(TRIM(pps.barcode))
    `);
    await pool.query(`
      UPDATE stock_movements sm SET product_id = p.id
      FROM products p
      WHERE sm.product_id IS NULL AND LOWER(TRIM(p.barcode)) = LOWER(TRIM(sm.barcode))
    `);

    // vehicle_info predates Vehicle Master and previously had a different, narrower column set
    // (see shared/schema.ts's comment on the vehicleInfo table) — add whatever's missing rather
    // than assuming a fresh table. Existing rows simply get NULL for these until synced/edited.
    await pool.query(`
      ALTER TABLE vehicle_info
        ADD COLUMN IF NOT EXISTS notion_page_id TEXT,
        ADD COLUMN IF NOT EXISTS series TEXT,
        ADD COLUMN IF NOT EXISTS company_type TEXT,
        ADD COLUMN IF NOT EXISTS ac_truck_url TEXT,
        ADD COLUMN IF NOT EXISTS company TEXT,
        ADD COLUMN IF NOT EXISTS manufacturer TEXT,
        ADD COLUMN IF NOT EXISTS model_year TEXT,
        ADD COLUMN IF NOT EXISTS engine TEXT,
        ADD COLUMN IF NOT EXISTS volume REAL,
        ADD COLUMN IF NOT EXISTS vehicle_percent REAL,
        ADD COLUMN IF NOT EXISTS gps TEXT,
        ADD COLUMN IF NOT EXISTS for_gps TEXT,
        ADD COLUMN IF NOT EXISTS driver TEXT,
        ADD COLUMN IF NOT EXISTS record_driver TEXT,
        ADD COLUMN IF NOT EXISTS plant TEXT,
        ADD COLUMN IF NOT EXISTS status TEXT,
        ADD COLUMN IF NOT EXISTS remark TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_fitness TEXT,
        ADD COLUMN IF NOT EXISTS latest_entry TEXT,
        ADD COLUMN IF NOT EXISTS latest_order TEXT,
        ADD COLUMN IF NOT EXISTS link_to_vehicle TEXT,
        ADD COLUMN IF NOT EXISTS order_current TEXT,
        ADD COLUMN IF NOT EXISTS order_backup TEXT,
        DROP COLUMN IF EXISTS ac_truck,
        DROP COLUMN IF EXISTS order_by,
        DROP COLUMN IF EXISTS order_cl,
        DROP COLUMN IF EXISTS link_to_rto,
        DROP COLUMN IF EXISTS link_to_sr
    `);
    // rto_number was NOT NULL in the original table — Vehicle Master's Notion sync can create
    // a row before that field is known, so this column needs to allow NULL going forward.
    await pool.query(`ALTER TABLE vehicle_info ALTER COLUMN rto_number DROP NOT NULL`);

    // Vehicle Master's real identity is notionPageId now, not vehicleNumber — two different
    // Notion pages (two vehicles, or intentionally more than one page for the same one) can
    // legitimately share a vehicle number; that's no longer treated as a sync conflict (see
    // server/services/notionVehicleSync.ts). Drop the old uniqueness/requiredness on
    // vehicle_number, and make notion_page_id unique instead — that's what now guarantees one
    // row per Notion page.
    await pool.query(`ALTER TABLE vehicle_info DROP CONSTRAINT IF EXISTS vehicle_info_vehicle_number_unique`);
    await pool.query(`ALTER TABLE vehicle_info ALTER COLUMN vehicle_number DROP NOT NULL`);
    try {
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'vehicle_info_notion_page_id_unique'
          ) THEN
            ALTER TABLE vehicle_info ADD CONSTRAINT vehicle_info_notion_page_id_unique UNIQUE (notion_page_id);
          END IF;
        END $$;
      `);
    } catch (err) {
      // Only fails if some past sync run already left two rows sharing a notion_page_id — should
      // never happen (each page always resolved to at most one row even under the old logic),
      // but this is a startup migration and must never crash the server over a pre-existing data
      // issue; log it so it's visible/fixable instead.
      console.error('Failed to add vehicle_info_notion_page_id_unique constraint — check for duplicate notion_page_id rows:', (err as Error)?.message);
    }

    console.log('Database migrations completed successfully');

    // Auto-sync scan history to the configured Notion inventory DB every 30 minutes. No-ops
    // quietly until a Notion DB is configured (via a manual upload or SCAN_HISTORY_NOTION_DB_ID),
    // and skips a tick if the previous run is still going — see runAutoScanHistorySync.
    const { runAutoScanHistorySync } = await import('./services/scanHistoryNotionSync');
    const SCAN_HISTORY_SYNC_INTERVAL_MS = 15 * 60 * 1000;
    setInterval(() => { void runAutoScanHistorySync(); }, SCAN_HISTORY_SYNC_INTERVAL_MS);
    // Kick one off shortly after boot so it doesn't wait a full interval.
    setTimeout(() => { void runAutoScanHistorySync(); }, 15 * 1000);
  } catch (error) {
    console.error('Error running migrations:', error);
  }


  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

  // ALWAYS serve the app on a configurable port (env PORT) with sensible default
  const DEFAULT_PORT = 3000;
  const port = Number(process.env.PORT || process.env.NODE_PORT || DEFAULT_PORT) || DEFAULT_PORT;

  const MAX_FALLBACK_TRIES = 3;
  let fallbackAttempts = 0;

  function startListening(p: number) {
    try {
      server.listen(p, () => {
        log(`serving on port ${p}`);
      });
    } catch (err: any) {
      log(`listen threw synchronously: ${String(err)}`);
      process.exit(1);
    }

    server.on("error", (err: any) => {
      // Common listen errors: EACCES, EADDRINUSE, ENOTSUP
      log(`server listen error: ${err?.code || err?.message || err}`);

      if (err.code === "EADDRINUSE") {
        // try next port up to a few times
        if (fallbackAttempts < MAX_FALLBACK_TRIES) {
          fallbackAttempts++;
          const nextPort = p + fallbackAttempts;
          log(`port ${p} in use, trying fallback port ${nextPort}`);
          setTimeout(() => startListening(nextPort), 200);
          return;
        }
        log(`port ${p} still in use after ${MAX_FALLBACK_TRIES} attempts`);
        process.exit(1);
      }

      if (err.code === "EACCES") {
        log(`permission denied binding to port ${p}. Try a higher port or run with proper privileges.`);
        process.exit(1);
      }

      if (err.code === "ENOTSUP") {
        log(`ENOTSUP when trying to listen on ${p} — environment may not support requested listen options.`);
        // don't retry blindly; exit so you can inspect runtime/compiled file that tries port 5000
        process.exit(1);
      }

      // Unknown error — rethrow / exit
      console.error(err);
      process.exit(1);
    });
  }

  // Start server
  startListening(port);
})();
