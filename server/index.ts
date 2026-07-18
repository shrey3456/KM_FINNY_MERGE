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
    // Delete-with-rollback for order-import CSVs: tracks who deleted a session and links a
    // deleted session to whichever replacement CSV later carried its scan history forward.
    await pool.query(`
      ALTER TABLE order_import_sessions
      ADD COLUMN IF NOT EXISTS deleted_by_code TEXT,
      ADD COLUMN IF NOT EXISTS remapped_to_session_id INTEGER,
      ADD COLUMN IF NOT EXISTS remapped_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS replaces_session_id INTEGER
    `);
    console.log('Database migrations completed successfully');
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
