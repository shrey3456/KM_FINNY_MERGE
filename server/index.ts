import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { pool } from "./db";


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

app.use(express.json({ limit: '10mb' }));
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
    // safe to run on every server start — a no-op once everything's backfilled.
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
      WHERE pps.product_id IS NULL AND LOWER(p.barcode) = LOWER(pps.barcode)
    `);
    await pool.query(`
      UPDATE stock_movements sm SET product_id = p.id
      FROM products p
      WHERE sm.product_id IS NULL AND LOWER(p.barcode) = LOWER(sm.barcode)
    `);

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
