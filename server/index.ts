import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { pool } from "./db";
import { tagStockMovementSources } from './lib/stockRecalc';
import { ensureManualSalesSchema } from './lib/manualSalesSchema';


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

  // Manual Sales tables — created here on every start (no `npm run db` step), before the long chain below.
  try {
    await ensureManualSalesSchema(pool);
  } catch (error) {
    console.error('Could not create the Manual Sales tables:', error);
  }

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
      ALTER TABLE plants
      ADD COLUMN IF NOT EXISTS require_sort_slip_first BOOLEAN DEFAULT false
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
    // Same role again, for the Proforma Slips Notion sync (server/services/proformaNotionSync.ts)
    // — gates the 5-hour scheduled sync's auto-apply, same as the two above.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS proforma_sync_config (
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
    // Per-plant breakdown of a loading_scan_events row's stock debit — see server/lib/statePool.ts.
    // Loading now pools stock across every plant in the same state (plants.state), so a single
    // scan can pull from more than one plant's product_plant_stock row; this is what lets a void
    // or reset credit each contributing plant back exactly, instead of assuming it all came from
    // the loading plant's own row.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loading_stock_pulls (
        id SERIAL PRIMARY KEY,
        loading_scan_event_id INTEGER NOT NULL REFERENCES loading_scan_events(id) ON DELETE CASCADE,
        source_plant TEXT NOT NULL,
        qty INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_loading_stock_pulls_event_id ON loading_stock_pulls(loading_scan_event_id)
    `);
    // Sort Slip (server/routes/sort-slips.ts) — godown picking. See sortSlips in shared/schema.ts:
    // these tables are the ONLY place a pick is written; nothing here feeds Load Operations.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sort_slips (
        id SERIAL PRIMARY KEY,
        order_number TEXT NOT NULL UNIQUE,
        proforma_slip_id INTEGER,
        party_name TEXT,
        plant TEXT,
        order_date DATE,
        total_qty INTEGER DEFAULT 0,
        status TEXT DEFAULT 'unassigned',
        created_by_code TEXT REFERENCES users(user_code),
        created_by_name TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        activated_at TIMESTAMP,
        completed_at TIMESTAMP,
        completed_by_code TEXT REFERENCES users(user_code),
        completed_by_name TEXT,
        notes TEXT
      )
    `);
    // platform_stv — the STV (platform) picked when the slip is created, same plantStvs concept
    // proforma_slips.loading_stv already uses for Loading. ADD COLUMN separately (not just in the
    // CREATE TABLE above) since sort_slips already existed before this field did.
    await pool.query(`ALTER TABLE sort_slips ADD COLUMN IF NOT EXISTS platform_stv TEXT`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sort_slip_assignees (
        id SERIAL PRIMARY KEY,
        sort_slip_id INTEGER NOT NULL REFERENCES sort_slips(id) ON DELETE CASCADE,
        user_code TEXT NOT NULL REFERENCES users(user_code),
        user_name TEXT,
        assigned_by_code TEXT REFERENCES users(user_code),
        assigned_by_name TEXT,
        assigned_at TIMESTAMP DEFAULT NOW(),
        removed_at TIMESTAMP,
        removed_by_code TEXT REFERENCES users(user_code),
        is_active BOOLEAN DEFAULT true
      )
    `);
    // "One active slip per loader", guaranteed by the database rather than by a check in the
    // route: two supervisors assigning the same loader at the same moment cannot both win, and
    // the route turns the constraint violation into a readable message naming the other slip.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS sort_slip_one_active_per_loader
        ON sort_slip_assignees (user_code) WHERE is_active
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sort_slip_picks (
        id SERIAL PRIMARY KEY,
        sort_slip_id INTEGER NOT NULL REFERENCES sort_slips(id) ON DELETE CASCADE,
        order_number TEXT NOT NULL,
        proforma_slip_item_id INTEGER,
        barcode TEXT,
        sr_no TEXT,
        item_name TEXT,
        qty INTEGER NOT NULL,
        picked_by_code TEXT REFERENCES users(user_code),
        picked_by_name TEXT,
        picked_at TIMESTAMP DEFAULT NOW(),
        voided BOOLEAN DEFAULT false,
        voided_by_code TEXT REFERENCES users(user_code),
        voided_at TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sort_slip_picks_slip ON sort_slip_picks(sort_slip_id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sort_slip_handoffs (
        id SERIAL PRIMARY KEY,
        sort_slip_id INTEGER NOT NULL REFERENCES sort_slips(id) ON DELETE CASCADE,
        order_number TEXT NOT NULL,
        from_user_code TEXT REFERENCES users(user_code),
        from_user_name TEXT,
        to_user_code TEXT REFERENCES users(user_code),
        to_user_name TEXT,
        transferred_by_code TEXT REFERENCES users(user_code),
        transferred_by_name TEXT,
        transferred_at TIMESTAMP DEFAULT NOW(),
        reason TEXT
      )
    `);
    // managed_by_code/name — the supervisor who currently owns a slip's assignment (see the
    // column's comment in shared/schema.ts). Backfilled once from what ownership already meant
    // before this column existed (the active assignee's assigned_by_code, or the slip's own
    // creator when nobody's currently assigned) so existing slips don't silently change hands the
    // moment this ships.
    await pool.query(`ALTER TABLE sort_slips ADD COLUMN IF NOT EXISTS managed_by_code TEXT REFERENCES users(user_code)`);
    await pool.query(`ALTER TABLE sort_slips ADD COLUMN IF NOT EXISTS managed_by_name TEXT`);
    await pool.query(`
      UPDATE sort_slips s SET
        managed_by_code = COALESCE(
          (SELECT a.assigned_by_code FROM sort_slip_assignees a WHERE a.sort_slip_id = s.id AND a.removed_at IS NULL LIMIT 1),
          s.created_by_code
        ),
        managed_by_name = COALESCE(
          (SELECT a.assigned_by_name FROM sort_slip_assignees a WHERE a.sort_slip_id = s.id AND a.removed_at IS NULL LIMIT 1),
          s.created_by_name
        )
      WHERE s.managed_by_code IS NULL
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
    // The retired "load-operations" page grant. "Load Operations" in the sidebar is the /loading
    // page (key "loading"); the old /load-operations screen carried the same name in the User
    // Management list, so granting the obvious one gave a page that is not in the sidebar at all
    // and nothing appeared. That entry is gone from the grantable list (shared/pageKeys.ts), which
    // also means it can no longer be UNticked by hand — so any copy still sitting on a user is
    // taken out here. Nothing is granted in its place: whoever should have Load Operations gets it
    // by ticking it, now that the name in the list matches the sidebar.
    for (const column of ['allowed_pages', 'page_write_access']) {
      const { rowCount } = await pool.query(`
        UPDATE users
        SET ${column} = COALESCE((
          SELECT jsonb_agg(value)::text
          FROM jsonb_array_elements_text(${column}::jsonb) AS value
          WHERE value <> 'load-operations'
        ), '[]')
        WHERE ${column} IS NOT NULL
          AND TRIM(${column}) LIKE '[%'
          AND ${column} LIKE '%"load-operations"%'`);
      if (rowCount) console.log(`[migration] removed the retired load-operations grant from ${rowCount} user(s) (${column})`);
    }

    // hidden_in_history — "Remove entry" on the Scan History page, allowed only on a row that is
    // already VOIDED or on a stock line written by Settings > Remove All Operations Data (see the
    // endpoint, which re-checks that rule). The row itself is KEPT on purpose: Overall Stock sums
    // its Opening/Purchase/Sale straight out of stock_movements, and a voided scan is what proves
    // the void happened — deleting either would quietly change numbers that are already right.
    // The flag only takes the line out of the Scan History list, and Activities records who did it.
    for (const table of ['order_scan_events', 'loading_scan_events', 'unload_scan_events', 'stock_movements']) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS hidden_in_history BOOLEAN DEFAULT false`);
    }
    // adjusted_at — when a scan was CORRECTED, kept apart from scanned_at, when it happened.
    // A qty edit voids the old row and writes a fresh one (the FIFO credit machinery makes an
    // in-place update unsafe), and that fresh row used to be stamped with the edit's own time —
    // so a correction made today to a scan from the 16th read as if the boxes arrived today, and
    // the real date was lost from the history. The corrected row now carries the ORIGINAL scan
    // time in scanned_at and the edit time here, so both are on screen.
    for (const table of ['order_scan_events', 'loading_scan_events', 'unload_scan_events']) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS adjusted_at TIMESTAMP`);
    }
    // Settings' own ledger lines (Clear Stock, Remove All Operations Data) write one row per item
    // — hundreds at a time — and they filled Scan History with "Stock Adjust" entries nobody
    // scanned. New ones are written hidden; the ones past runs already left behind are hidden here.
    // They stay in stock_movements on purpose: Overall Stock sums Opening/Purchase/Sale out of that
    // table, so deleting them would make it show cleared stock as still on hand.
    {
      const { rowCount } = await pool.query(`
        UPDATE stock_movements SET hidden_in_history = true
        WHERE type = 'adjust' AND NOT COALESCE(hidden_in_history, false)
          AND (reason LIKE 'Clear Stock (Settings)%' OR reason LIKE 'Remove operations data (Settings)%')`);
      if (rowCount) console.log(`[migration] hid ${rowCount} Settings stock-correction row(s) from Scan History`);
    }
    // Remove All Operations Data used to write a minus ledger line per item AND delete the very
    // rows that line was offsetting, in the same run. What is left is a correction with nothing
    // to correct: Stock Overview adds up the survivors and reports a purchase of minus a million
    // for stock that no longer has any record of arriving. The action no longer writes them (it
    // corrects the stock directly), so the orphans from earlier runs are cleared out here.
    // Clear Stock's own lines are deliberately NOT touched — that action leaves its purchases in
    // place, so its minus line is what explains the clear.
    {
      const { rowCount } = await pool.query(
        `DELETE FROM stock_movements WHERE type = 'adjust' AND reason LIKE 'Remove operations data (Settings)%'`,
      );
      if (rowCount) console.log(`[migration] removed ${rowCount} orphaned "Remove operations data" ledger row(s)`);
    }
    // stock_movements.origin — WHO made a correction, as a real value rather than something to be
    // guessed from the reason text (which changes the moment a message is reworded, or when the
    // person types their own):
    //   'page'      a per-item edit from Stock Overview's Adjust dialog
    //   'operation' a correction a normal action produced — a voided scan, a deleted CSV, an
    //               exchange, a loading/unloading qty edit
    //   'settings'  a Settings-wide action: Clear Stock (Remove All Operations Data no longer
    //               writes any ledger line at all)
    // Stock Overview keeps the first two together as Adjust and the third in its own column, so a
    // bulk clear can never swamp the corrections an operator actually made.
    await pool.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS origin TEXT`);
    // products.box_image / box_image_hash — Notion's second image per product ("Box Image", the
    // packed carton). Cached on disk like the product shot, under <id>-box.jpg.
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS box_image TEXT`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS box_image_hash TEXT`);
    // products.product_image_ref / box_image_ref — which Notion file the cached picture came
    // from. Left NULL here on purpose: the next sync reads "ref unknown" as "check this one",
    // downloads it once to fill the column in, and from then on a replaced picture is spotted
    // without downloading anything.
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_image_ref TEXT`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS box_image_ref TEXT`);
    {
      const { rowCount } = await pool.query(`
        UPDATE stock_movements SET origin = CASE
            WHEN reason LIKE 'Clear Stock (Settings)%'
              OR reason LIKE 'Remove operations data (Settings)%' THEN 'settings'
            WHEN source = 'manual' THEN 'page'
            ELSE 'operation'
          END
        WHERE origin IS NULL AND type IN ('adjust', 'exchange')`);
      if (rowCount) console.log(`[migration] tagged ${rowCount} existing stock correction(s) with where they came from`);
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

    // activities.created_at was written via the column's old defaultNow() default, which casts
    // now() to `timestamp` using the Postgres SESSION's TimeZone setting — Asia/Calcutta on this
    // server — storing IST wall-clock digits. Drizzle always reads a naive `timestamp` column as
    // UTC (see shared/schema.ts's comment on this column), so every activity's time displayed
    // 5:30 ahead of when it actually happened. The column's default is now `(now() AT TIME ZONE
    // 'UTC')`, which stores true UTC digits regardless of session TimeZone; this corrects rows
    // already written under the old default. created_at_tz_fixed marks a row as done so a
    // restart never shifts an already-fixed row a second time.
    await pool.query(`ALTER TABLE activities ALTER COLUMN created_at SET DEFAULT (now() AT TIME ZONE 'UTC')`);
    await pool.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS created_at_tz_fixed BOOLEAN DEFAULT false`);
    {
      const { rowCount } = await pool.query(`
        UPDATE activities SET created_at = created_at - INTERVAL '5 hours 30 minutes', created_at_tz_fixed = true
        WHERE NOT COALESCE(created_at_tz_fixed, false)`);
      if (rowCount) console.log(`[migration] corrected the stored time zone on ${rowCount} existing activity row(s)`);
    }

    // client_request_id — the offline queue's duplicate-safety net. A scan made while offline is
    // queued locally with a UUID generated once at scan time; if that request actually reaches
    // the server but the response is lost to a flaky connection, the queue retries it with the
    // SAME id. The partial unique index (NULLs excluded, since most rows predate this and never
    // set it) makes a second insert with a seen id fail at the database level even under a race,
    // not just whatever the route's own pre-check catches.
    for (const table of ['loading_scan_events', 'unload_scan_events', 'order_scan_events']) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS client_request_id TEXT`);
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_client_request_id_idx ON ${table} (client_request_id) WHERE client_request_id IS NOT NULL`,
      );
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

    // Auto-sync Vehicle Planning's local order history from Notion once a day — the page itself
    // only ever reads the local vehicle_planning_state table, so this (plus the manual "Sync from
    // Notion" button) is the only thing that keeps it from going stale. Skips a tick if the
    // previous run is still going — see runVehiclePlanningSync.
    const { runVehiclePlanningSync } = await import('./routes/vehicle-planning');
    const VEHICLE_PLANNING_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
    // .catch() here is load-bearing, not decoration: this runs completely unattended (a timer,
    // not a request with its own try/catch), so an unhandled rejection from inside the sync
    // doesn't just fail that one run — it crashes the ENTIRE server. This is exactly what
    // happened once already (an unbounded Promise.all exhausted the connection pool, timed out,
    // and took the whole process down with it — see mapWithConcurrency's own comment for the fix
    // to that specific cause). This catch is the backstop for any OTHER failure mode, now or later.
    const logVehiclePlanningSyncFailure = (err: unknown) => console.error('[Vehicle Planning] Scheduled sync failed:', err);
    setInterval(() => { runVehiclePlanningSync().catch(logVehiclePlanningSyncFailure); }, VEHICLE_PLANNING_SYNC_INTERVAL_MS);
    // Kick one off shortly after boot so the page isn't empty until the first daily tick.
    setTimeout(() => { runVehiclePlanningSync().catch(logVehiclePlanningSyncFailure); }, 20 * 1000);
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
