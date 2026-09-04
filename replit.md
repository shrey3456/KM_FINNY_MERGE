# KM Finny Operations Management System

## Overview

KM Finny is a manufacturing operations management system covering order intake, barcode-scan receiving, inventory/stock tracking, proforma slip generation and printing, dispatch, and vouchers. It is built as a Progressive Web App (PWA) with offline capabilities and a mobile-first design. Product master data is synced one-way from Notion into Postgres (not read live); Dispatch and Expense Voucher still fetch live from Notion at request time. Everything else — order import, barcode scanning, stock ledger, proforma slips, reports — is native Postgres via Drizzle ORM, with no Notion dependency.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript.
- **Styling**: Tailwind CSS with Shadcn UI for consistent design.
- **State Management**: TanStack React Query for server state management and caching.
- **Routing**: Wouter for lightweight client-side routing.
- **Build Tool**: Vite for fast development and optimized production builds.
- **UI/UX**: Mobile-first, touch-optimized interfaces with consistent branding (KM Finny blue theme). Features like splash screen fade effect and restored original logos contribute to brand consistency.

### Backend Architecture
- **Runtime**: Node.js with Express.js server framework.
- **Language**: TypeScript for full-stack type safety.
- **API Design**: RESTful APIs with standard HTTP methods.
- **Build Process**: ESBuild for server bundling and production deployment.
- **Deployment**: Self-hosted GitHub Actions runner triggers `deploy.bat` on push to `main`, which pulls, installs, migrates, builds, and restarts via pm2.

### Database Layer
- **Database**: PostgreSQL for reliable relational data storage.
- **ORM**: Drizzle ORM for type-safe database operations and migrations (schema in `shared/schema.ts`).
- **Connection**: Neon Database serverless PostgreSQL connection (production); a regular local Postgres instance is used for local dev.
- **Key table groups**: `order_import_sessions`/`order_import_items` (arriving-order CSVs), `order_scan_items`/`order_scan_events` (per-scan audit trail, the source of truth for received qty/pallets/timing), `product_plant_stock`/`stock_movements` (live per-plant stock ledger), `proforma_slips`/`proforma_slip_items`, `scan_history`, `products`, `users`, `plants`/`plant_stvs`, `activities` (audit log), `messages`.

## Pages & Flows

### Order intake → scan → stock pipeline (the core, Postgres-native workflow)
- **Order Import** (`/order-import`, `OrderImport.tsx`) — entry point. Upload a CSV/Excel of an arriving order with a column-mapping dialog (auto-matches headers, user can override); files sharing plant+order date auto-group into one FIFO batch ("Part 1", "Part 2", ...; a retired part number is never reused, even after delete+reupload, so numbering can visibly skip). Per-session actions: activate for scanning, edit, delete (with a scanned/stock-impact preview), and a Reports dialog (Summary, Activity, and Hourly reports — see below).
- **Scan** (`/scan`, `Scanning/Scan.tsx`) — the scanning workstation. Tabs: **Scan** (live barcode scanning against the active session, camera via `@zxing/library` or keyboard entry), **Master View** (all CSV parts for a plant+date merged into one view, including Extras that were never on any CSV), **Part Order** (per-file view). Writes `order_scan_items`/`order_scan_events`; records `scanActivatedAt`/`scanCompletedAt` per session.
- **Scan Viewer** (`/scan-viewer`, `ScanViewer.tsx`) — read-oriented monitor/second-device view of the same order-scan state (Master View + Part Order), with a header showing plant, loaded-by, start/completed/active-for timing, date filter, and part picker.
- **Reports** (embedded per-session dialog in Order Import, `components/modals/ReportsDialog.tsx`) — Summary (expected/received/extra/missing per item), Activity (every individual scan event), and **Hourly** report (scans bucketed into rolling 1-hour windows anchored to the session's actual start time, not clock-hour boundaries; viewable as an expandable per-hour list or downloaded as CSV/Excel/PDF, for a single CSV or the whole FIFO group). All three reports also show Started/Completed/Active-For per part.
- **Scan History** (`/reports`, `Scanning/Reports.tsx`) — a flat, filterable, backend-paginated log of every individual scan event, with Excel-style per-column filters, void/edit actions, and Excel/PDF export.
- **Overall Stock** (`/overall-stock`, `OverallStock.tsx`) — the live per-plant stock dashboard: in-stock, extra, expected (from order-import), sale (from proforma slips) per barcode+plant, plus date-range mode reading the `stock_movements` ledger for received-in-window quantities. Empty-box scans are tracked separately, not as product stock.
- **Order Management** (`/order-management`, `OrderManagement.tsx`) — an older, simpler CSV importer into `orders`/`order_items` (no scan tracking), kept alongside Order Import as a separate/legacy path.

### Sales documents & printing
- **Proforma Slips** (`/proforma-slips`, `ProformaSlips.tsx`) — full CRUD for proforma slips, importable from Notion or CSV, then managed natively (`proforma_slips`/`proforma_slip_items`). Lock/unlock ties into the print-lock state shared with Print Operations.
- **Print Operations** (`/print-operations`, `PrintOperationsFinal12.tsx`) — order-number lookup → preview → print (PDF/canvas via jsPDF + html2canvas) → auto-lock. The auto-lock triggered by printing only requires **read** access to both Print Operations and Proforma; the manual Lock/Unlock button on the Proforma Slips page requires **write** access to Proforma.
- **Dispatch** (`/dispatch`, `Dispatch.tsx`) — order-number lookup that fetches **live from Notion** (dispatch + party databases), with inline-editable invoice/vehicle fields and a printable layout.
- **Expense Voucher** (`/expense-voucher`) / **Toll Voucher** (`/toll-voucher`) — order-number-driven voucher printing, same family as Dispatch; toll vouchers use a prefix from `voucher_prefixes` (editable in Settings).

### Inventory & purchasing
- **Notion Inventory / Product Master** (`/notion-inventory`, `NotionInventory.tsx`) — the product catalog, synced one-way from Notion into Postgres (`products`); "Sync Notion" (fields) vs "Sync Photos" (slower, re-downloads images), with a pending-changes review/diff before applying, plus a 24h auto-sync.
- **Purchases** (`/purchases`, `Purchases.tsx`) — dealer purchase orders, imported from Excel/CSV (`purchase_orders`/`purchase_order_items`, aliased in code as `DealerPurchaseOrder`/`Item`).
- **Stock Sheets** (`/stock-sheets`, `StockSheets.tsx`) — daily reconciliation sheet with an inline-editable "company remaining" stock cell (optimistic update to `products.inStock`).

### Operations
- **Load Operations** (`/load-operations`, `LoadOperations.tsx`) — loading/dispatch tracking with Overall/Loading/Ready-Desp tabs, per-operation Items/Basket/Status sub-tabs, linked to proforma slips by order reference.

### Admin
- **Users** (`/users`) — user CRUD, per-page view/write access grants, plant assignment, role (admin/super-admin/read-write/read).
- **Plant Settings** (`/plant-settings`) — plant CRUD (badge theming, GJ/MP pallet-size state) plus per-plant toggles (`isLockingEnabled`, `isSplitPagesEnabled`, `isAutoCompleteEnabled`, `isAutoScanEnabled`) and per-plant STV list.
- **Settings** (`/settings`) — scanner/device settings, voucher-prefix editor, destructive "Clear Data" flow (admin-only, confirmation-gated).
- **Activities** (`/activities`) — paginated audit log with live-update polling.

### Other
- **Dashboard** (`/`) — launcher tile grid, permission-gated per role/allowed pages, with a live "Scan Available!" banner for scanning-department users.
- **Messages** (`/messages`) — single group chat, polling-based.
- **Check In/Out** (`/inout`, `/checkinout-admin`) — personal attendance calendar, read-only, still fetched **live from Notion** (not a Postgres table).
- **Profile** (`/profile`) — current user's profile card, QR code, profile-image upload.

### Core System Features & Implementations
- **Authentication System**: Session-based authentication using Express Session, custom scrypt-based password hashing, emergency admin PINs (9999, 0000), multi-level role system (read, read/write, admin, super-admin), client-side user session persistence, deployment-compatible secure cookie configuration with HTTPS support, and PIN uniqueness validation to prevent duplicate PINs across users.
- **Page-level access control**: per-user `allowedPages` (view) and `pageWriteAccess` (write) JSON arrays, enforced server-side via `requirePageAccess`/`requirePageWrite` middleware (`server/lib/pageAccess.ts`); a single endpoint can branch its required strictness by caller (e.g. print-triggered auto-lock needs only read access, the manual Lock button needs write).
- **Order Import → Scan → Stock pipeline**: CSV-driven FIFO order intake, barcode-gun/camera scanning against expected quantities with Extra/Missing/Empty-Box handling, credit-reconciliation between FIFO parts, and a live per-plant stock ledger (`product_plant_stock`/`stock_movements`) — see "Pages & Flows" above for detail.
- **Scan timing & Hourly report**: every scan session records `scanActivatedAt`/`scanCompletedAt`; surfaced as Started/Completed/Active-For across Order Import History, Scan Viewer, and every Summary/Activity/Hourly report export. The Hourly report buckets individual scans into rolling 1-hour windows anchored to the session's real start time, expandable per hour, downloadable whole or per-hour.
- **Loading Operations Management**: CRUD operations for loading/dispatch, status tracking (LOADING, READY/DESP, PENDING DESP), multi-tab edit interface, real-time quantity tracking, plant-based filtering, and integration with proforma slip generation.
- **Proforma Slip System**: Dynamic generation from loading operations, PDF export with plant-specific branding, historical tracking, batch processing, and print-optimized layouts. Dates are formatted as DD/MM/YYYY.
- **Reporting & Analytics**: Scan History (backend-filtered/paginated), Overall Stock dashboard, activity logging, and per-order Summary/Activity/Hourly export capabilities.
- **PWA Features**: Service worker for offline support, native-like installation prompts, and responsive design.
- **Data Integrity**: Robust handling of unmatched items, order deduplication, and item aggregation to prevent data inconsistencies.
- **Performance Optimizations**: Optimized session deserialization, intelligent query client retry logic, and improved error handling. Dispatch search performance reduced from over 135 seconds to approximately 8 seconds through API and query optimizations.
- **Dispatch Preview System**: Fetches live data from Notion databases, filters orders by "Dispatched" and "Ready for Dispatch" statuses, and is integrated into the navigation.
- **Enhanced Dispatch System**: Comprehensive dispatch management with integrated party database lookup using exact party name matching. Streamlined Order Details interface displaying only essential fields (Order Date, Order Number, Plant, Status, Party Name, Party Area, Vehicle x Driver, Invoice Number, Invoice Amount). Party contact and address information automatically sourced from dedicated party database (0da8aefd54554a75971f3726eaabcd42) for accurate contact details.
- **Notion Integration**: Product master (one-way sync into Postgres), proforma slip import (one-time, into Postgres), Dispatch (live per-request: dispatch database 296851d9af9e4a14966376e58f8475e5 + party database 0da8aefd54554a75971f3726eaabcd42), and Check In/Out (live per-request) — this is the current, narrower scope of Notion dependence; it is no longer the system of record for orders, scanning, or stock.

## External Dependencies

### Core Dependencies
- **@tanstack/react-query**: Server state management and caching.
- **@radix-ui/***: Accessible UI primitives.
- **wouter**: Lightweight routing library.
- **drizzle-orm**: Type-safe database operations.
- **@neondatabase/serverless**: Serverless PostgreSQL connection.
- **date-fns**: Date manipulation and formatting.
- **jspdf** / **jspdf-autotable**: PDF generation for reports and slips.
- **html2canvas**: Canvas capture for print/PDF layouts.
- **xlsx**: Excel export for reports.
- **@zxing/library**: Camera-based barcode scanning (Scan page).
- **qrcode**: QR code generation (Dispatch, vouchers, Profile).
- **papaparse**: CSV parsing (imports).
- **embla-carousel-react**: Dashboard image carousel.

### Development Tools
- **TypeScript**: Static type checking.
- **Vite**: Development server and build tooling.
- **ESBuild**: Server-side bundling.
- **PostCSS**: CSS processing with Tailwind CSS.

### Authentication & Security
- **express-session**: Session management.
- **passport**: Authentication middleware (with local strategy).
- **crypto**: Node.js built-in for password hashing.