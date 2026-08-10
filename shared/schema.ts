import { pgTable, text, serial, integer, boolean, timestamp, date, real, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ============================================================================
// USERS
// ============================================================================

export const users = pgTable("users", {
  userCode: text("user_code").primaryKey().notNull(), // unique employee ID, used as FK across all tables
  username: text("username").notNull().unique(),
  pin: text("pin").notNull(),
  name: text("name"),
  designation: text("designation"),
  department: text("department"),
  role: text("role").default("user"), // "user" | "admin"
  profileImage: text("profile_image"), // Base64-encoded JPEG
  plants: text("plants").default("[]"), // JSON array of plant names e.g. ["VALSAD","INDORE"]
  allowedPages: text("allowed_pages").default("[]"), // JSON array of page keys e.g. ["inventory","dispatch"]
  // Subset of allowedPages where this user can also write (not just view). A page key
  // present here without also being in allowedPages has no effect — read access is the
  // prerequisite. Admin/super-admin ignore this entirely (implicit full write access).
  pageWriteAccess: text("page_write_access").default("[]"),
});

export const insertUserSchema = createInsertSchema(users);

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

// ============================================================================
// PRODUCTS (Inventory Master)
// Purpose : Master catalogue of every product / SKU in the warehouse.
//           inStock / purchased / sold are live running totals updated on every
//           scan or purchase entry.
// Used by : Inventory page, Scan Order, Load Operations, Proforma Slips,
//           Pallet Stock Report.
// ============================================================================

export const products = pgTable("products", {
  id: serial("id").primaryKey(),

  // ── Core identity ─────────────────────────────────────────────────────────
  newSr: text("new_sr"),            // "New Sr." column — canonical cross-plant Sr
  itemNo: text("item_no"),          // internal item code
  barcode: text("barcode").notNull(), // SKU / barcode
  name: text("name").notNull(),     // "Products Name {DMS}"
  notionWiseName: text("notion_wise_name"), // "Products - Notion Wise"
  brand: text("brand"),             // Brand
  category: text("category"),       // Category
  saleCategory: text("sale_category"), // Sale Category (e.g. 01-PW, 03-CP)
  plant: text("plant"),             // Plant : (e.g. VAL & IND, BARODA, RAJKOT)
  type: text("type"),               // Type : (BOX / NOS / JAR)
  productImage: text("product_image"), // Local cached filename (server/uploads/product-images/<id>.jpg), not a URL
  productImageHash: text("product_image_hash"), // SHA-256 of the cached file's bytes — lets sync skip re-downloading unchanged images
  notionPageId: text("notion_page_id"), // Notion page.id for unique identification

  // ── Volume / pallet ───────────────────────────────────────────────────────
  volumeInCuFt: text("volume_in_cu_ft"), // "Vol Master :"
  itemsPerPallet: integer("items_per_pallet").default(0), // "Packets :"
  pallets: integer("pallets").default(0),
  // State-wise pallet size (renamed from the old plant-named indPlt/valPlt — a product's
  // pallet size is really a per-state fact, not a per-plant one; the plant that scans it just
  // looks up its own state via plants.state and reads the matching column here). Source Notion
  // property names are unchanged ("IND PLT :" / "VAL PLT :") — see notionInventorySync.ts.
  mpPlt: integer("mp_plt"),         // Madhya Pradesh — was "indPlt"/"ind_plt"
  gjPlt: integer("gj_plt"),         // Gujarat — was "valPlt"/"val_plt"

  // ── Stock counters (live totals) ───────────────────────────────────────────
  purchased: integer("purchased").default(0),
  sold: integer("sold").default(0),
  inStock: integer("in_stock").default(0),

  // ── GJ (Gujarat) region fields ────────────────────────────────────────────
  gjSr: text("gj_sr"),              // "GJ Sr :"
  gjHsn: text("gj_hsn"),           // "GJ HSN :"
  gjSap: text("gj_sap"),           // "GJ SAP :"
  gjSaleRate: text("gj_sale_rate"), // "GJ Sale Rate :"
  gjIgst: text("gj_igst"),         // "GJ IGST :"
  gjGaPur: text("gj_ga_pur"),      // "GJ-GA PUR"
  gjMhPur: text("gj_mh_pur"),      // "GJ-MH PUR"
  gjNagarPur: text("gj_nagar_pur"),// "GJ-NAGAR PUR"
  forGjOrderForm: text("for_gj_order_form"), // "For GJ Order Form :"

  // ── MP (Madhya Pradesh) region fields ─────────────────────────────────────
  mpSr: text("mp_sr"),              // "MP Sr :"
  mpHsn: text("mp_hsn"),           // "MP HSN :"
  mpSap: text("mp_sap"),           // "MP SAP :"
  mpJhPur: text("mp_jh_pur"),      // "MP-JH PUR"
  mpMhPur: text("mp_mh_pur"),      // "MP-MH PUR"
  mpMpPurJabalpur: text("mp_mp_pur_jabalpur"), // "MP-MP PUR JABALPUR"
  mpMpPurKhargone: text("mp_mp_pur_khargone"), // "MP-MP PUR KHARGONE"
  mpWbPur: text("mp_wb_pur"),      // "MP-WB PUR"
  saleMpJh: text("sale_mp_jh"),    // "Sale {MP - JH}:"
  saleMpMh: text("sale_mp_mh"),    // "Sale {MP - MH} :"
  saleMpMp: text("sale_mp_mp"),    // "Sale {MP-MP} :"
  mpJhIgst: text("mp_jh_igst"),    // "{MP - JH} IGST :"
  mpMhIgst: text("mp_mh_igst"),    // "{MP - MH} IGST :"
  mpMpCgst: text("mp_mp_cgst"),    // "{MP - MP} CGST :"
  mpMpSgst: text("mp_mp_sgst"),    // "{MP - MP} SGST :"
  mpWbIgst: text("mp_wb_igst"),    // "{MP-WB} IGST"
  mpWbSale: text("mp_wb_sale"),    // "{MP-WB} SALE"
  forMpOrderForm: text("for_mp_order_form"), // "For MP Order Form :"

  // ── UP (Uttar Pradesh) region fields ──────────────────────────────────────
  upSr: text("up_sr"),              // "UP Sr :"
  upHsn: text("up_hsn"),           // "UP HSN :"
  upSap: text("up_sap"),           // "UP SAP :"
  upRate: text("up_rate"),         // "UP Rate :"Not as.Not as big.Not as big over.Not as big a. 
  upIgst: text("up_igst"),         // "UP IGST :"
  forUpOrderForm: text("for_up_order_form"), // "For UP Order Form :"

  // ── Generic / fallback price fields ──────────────────────────────────────
  hsnCode: text("hsn_code"),       // generic HSN (may mirror gjHsn)
  sapCode: text("sap_code"),       // generic SAP (may mirror gjSap)
  purchasePrice: text("purchase_price"),
  sellingPrice: text("selling_price"), // generic selling price (may mirror gjSaleRate)

  // ── Misc ──────────────────────────────────────────────────────────────────
  lastUpdated: timestamp("last_updated"),
  lastChangedBy: text("last_changed_by"), // user who last changed this product via Notion sync
  description: text("description"),
  status: text("status").default("in stock"),
  createdByCode: text("created_by_code").references(() => users.userCode),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertProductSchema = createInsertSchema(products, {
  lastUpdated: z.union([z.date(), z.string()]).optional(),
}).pick({
  // core
  newSr: true, itemNo: true, barcode: true, name: true,
  notionWiseName: true, brand: true, category: true, saleCategory: true,
  plant: true, type: true, productImage: true, productImageHash: true, notionPageId: true,
  // volume / pallet
  volumeInCuFt: true, itemsPerPallet: true, pallets: true, mpPlt: true, gjPlt: true,
  // stock
  purchased: true, sold: true, inStock: true,
  // GJ
  gjSr: true, gjHsn: true, gjSap: true, gjSaleRate: true, gjIgst: true,
  gjGaPur: true, gjMhPur: true, gjNagarPur: true, forGjOrderForm: true,
  // MP
  mpSr: true, mpHsn: true, mpSap: true,
  mpJhPur: true, mpMhPur: true, mpMpPurJabalpur: true, mpMpPurKhargone: true, mpWbPur: true,
  saleMpJh: true, saleMpMh: true, saleMpMp: true,
  mpJhIgst: true, mpMhIgst: true, mpMpCgst: true, mpMpSgst: true, mpWbIgst: true, mpWbSale: true,
  forMpOrderForm: true,
  // UP
  upSr: true, upHsn: true, upSap: true, upRate: true, upIgst: true, forUpOrderForm: true,
  // generic price
  hsnCode: true, sapCode: true, purchasePrice: true, sellingPrice: true,
  lastUpdated: true, lastChangedBy: true, description: true, status: true, createdByCode: true,
});

export type Product = typeof products.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;

// ============================================================================
// SCAN HISTORY
// Purpose : Permanent audit log of every barcode scan that touches stock.
//           Each row records one scan event (add / remove / update) and the
//           quantity change. This is used for the Scan History page and for
//           tracing stock movement over time.
// Used by : Scan Order page (adds rows on each confirmed scan),
//           Scan History page, Reports page.
// ============================================================================

export const scanHistory = pgTable("scan_history", {
  id: serial("id").primaryKey(),
  barcode: text("barcode").notNull(),
  productId: integer("product_id").references(() => products.id),
  scannedByCode: text("scanned_by_code").references(() => users.userCode),
  scannedAt: timestamp("scanned_at").defaultNow(),
  action: text("action").notNull(),          // "add" | "remove" | "update"
  quantity: integer("quantity").default(1),
  notes: text("notes"),
  productSku: text("product_sku"),
  scannerName: text("scanner_name"),
  scannerDepartment: text("scanner_department"),
  productName: text("product_name"),
  isBackedUp: boolean("is_backed_up").default(false),
  orderNumber: text("order_number"),         // links this scan to a scan session order
});

export const insertScanHistorySchema = createInsertSchema(scanHistory).pick({
  barcode: true, productId: true, scannedByCode: true, action: true,
  quantity: true, notes: true, productSku: true, scannerName: true,
  scannerDepartment: true, productName: true, isBackedUp: true, orderNumber: true,
});

// Zod schema used for validating the POST /api/scans request body
export const scanEntrySchema = z.object({
  barcode: z.string().min(1, "Barcode is required"),
  quantity: z.number().int().positive().default(1),
  name: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  action: z.enum(["add", "remove", "update"]).default("add"),
  notes: z.string().optional(),
  productId: z.number().optional(),
  productSku: z.string().optional(),
  scannerName: z.string().optional(),
  scannerDepartment: z.string().optional(),
  scannedByCode: z.string().optional(),
  productName: z.string().optional(),
  isBackedUp: z.boolean().optional(),
  orderNumber: z.string().optional(),
});

export type ScanHistory = typeof scanHistory.$inferSelect;
export type InsertScanHistory = z.infer<typeof insertScanHistorySchema>;
export type ScanEntry = z.infer<typeof scanEntrySchema>;

// ============================================================================
// SCAN ORDER SESSIONS  (Pallet Stock Report / Arrival Scanning)
// Purpose : Tracks a stock-arrival scanning job created from a CSV import.
//           The user uploads an order CSV, creates a session, then scans each
//           arriving box. The system compares scanned qty vs expected qty from
//           the CSV and surfaces extras or shortfalls.
//
// Table relationships:
//   scanSessions         — one session per CSV order (the "job header")
//   scanSessionItems     — one row per product in the CSV (expected qty tracked here)
//   scanSessionExtras    — boxes scanned that were NOT listed in the CSV order
//   scanSessionPalletScans — one row per individual pallet scan event (audit trail)
//
// Used by : Scan Order page (/scan), Pallet Stock Report (/scan-stock-report).
// ============================================================================

// Header — one session = one CSV order import
export const scanSessions = pgTable("scan_sessions", {
  id: serial("id").primaryKey(),
  orderName: text("order_name").notNull(),   // label chosen by the user (e.g. dealer name)
  csvName: text("csv_name").notNull(),        // original filename of the uploaded CSV
  plant: text("plant"),                       // plant scope for dispatch filtering (e.g. VALSAD / INDORE)
  stv: text("stv"),                           // selected STV for dispatch flow
  mappedColumn: text("mapped_column").notNull(), // which CSV column was selected as the order
  status: text("status").default("scanning"), // "scanning" | "completed"
  createdByCode: text("created_by_code").references(() => users.userCode),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Expected items from the CSV — scannedQty increments on each confirmed scan
export const scanSessionItems = pgTable("scan_session_items", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").references(() => scanSessions.id, { onDelete: "cascade" }).notNull(),
  sku: text("sku").notNull(),
  itemName: text("item_name").notNull(),
  barcode: text("barcode"),
  itemNo: text("item_no"),
  sapCode: text("sap_code"),
  productId: integer("product_id").references(() => products.id),
  expectedQty: integer("expected_qty").default(0),  // qty from the CSV
  scannedQty: integer("scanned_qty").default(0),    // actual qty scanned so far
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Items scanned that did not match any row in the CSV order
export const scanSessionExtras = pgTable("scan_session_extras", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").references(() => scanSessions.id, { onDelete: "cascade" }).notNull(),
  code: text("code").notNull(),           // the barcode or code that was scanned
  itemName: text("item_name").notNull(),
  sku: text("sku"),
  productId: integer("product_id").references(() => products.id),
  quantity: integer("quantity").default(0),
  reason: text("reason").notNull(),       // "not_in_order" | "unknown_product"
  scannedByCode: text("scanned_by_code"),
  scannedByName: text("scanned_by_name"),
  scannedAt: timestamp("scanned_at").defaultNow(),
});

// Individual pallet-level scan events — one row per confirmed scan click.
// palletNumber is auto-incremented per item within the session.
export const scanSessionPalletScans = pgTable("scan_session_pallet_scans", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").references(() => scanSessions.id, { onDelete: "cascade" }).notNull(),
  sessionItemId: integer("session_item_id").references(() => scanSessionItems.id, { onDelete: "set null" }),
  barcode: text("barcode").notNull(),
  sku: text("sku"),
  itemName: text("item_name").notNull(),
  productId: integer("product_id").references(() => products.id),
  palletNumber: integer("pallet_number").notNull(), // sequential per item in this session
  quantity: integer("quantity").notNull().default(1),
  numPallets: real("num_pallets"),                  // calculated: quantity ÷ itemsPerPallet (e.g. 1.03)
  isExtra: boolean("is_extra").default(false),      // true = not matched to the order
  stv: text("stv"),                                 // STV selected by dispatch user for this scan
  scannedByCode: text("scanned_by_code").references(() => users.userCode),
  scannedByName: text("scanned_by_name"),
  scannedAt: timestamp("scanned_at").defaultNow(),
});

export const insertScanSessionSchema = createInsertSchema(scanSessions).pick({
  orderName: true, csvName: true, plant: true, stv: true, mappedColumn: true, status: true,
  createdByCode: true, createdByName: true,
});

export const insertScanSessionItemSchema = createInsertSchema(scanSessionItems).pick({
  sessionId: true, sku: true, itemName: true, barcode: true, itemNo: true,
  sapCode: true, productId: true, expectedQty: true, scannedQty: true,
});

export const insertScanSessionExtraSchema = createInsertSchema(scanSessionExtras).pick({
  sessionId: true, code: true, itemName: true, sku: true, productId: true,
  quantity: true, reason: true, scannedByCode: true, scannedByName: true,
});

export const insertScanSessionPalletScanSchema = createInsertSchema(scanSessionPalletScans).pick({
  sessionId: true, sessionItemId: true, barcode: true, sku: true, itemName: true,
  productId: true, palletNumber: true, quantity: true, numPallets: true, isExtra: true,
  stv: true, scannedByCode: true, scannedByName: true,
});

export type ScanSession = typeof scanSessions.$inferSelect;
export type ScanSessionItem = typeof scanSessionItems.$inferSelect;
export type ScanSessionExtra = typeof scanSessionExtras.$inferSelect;
export type ScanSessionPalletScan = typeof scanSessionPalletScans.$inferSelect;
export type InsertScanSessionPalletScan = z.infer<typeof insertScanSessionPalletScanSchema>;

// ============================================================================
// PROFORMA SLIPS  (Dispatch / Delivery Orders)
// Purpose : Proforma invoices raised before goods are dispatched to a dealer.
//           Each slip has a list of line items imported from a CSV.  Line item
//           data is stored as an IMMUTABLE SNAPSHOT so historical prints are
//           never affected by later inventory changes.
// Used by : Proforma Slips page, Print Operations page, Load Operations page.
// ============================================================================

export const proformaSlips = pgTable("proforma_slips", {
  id: serial("id").primaryKey(),
  orderDate: date("order_date").defaultNow(),
  orderNumber: text("order_number").notNull(),
  partyName: text("party_name").notNull(),  // dealer / customer name
  plant: text("plant"),
  totalQuantity: integer("total_quantity").default(0),
  totalVolume: text("total_volume"),
  vehicleNumber: text("vehicle_number"),
  driverName: text("driver_name"),
  createdByCode: text("created_by_code").references(() => users.userCode),
  createdAt: timestamp("created_at").defaultNow(),
  notes: text("notes"),
  isBackedUp: boolean("is_backed_up").default(false),
  isPrintLocked: boolean("is_print_locked").default(false), // prevents edits after first print
  printedByCode: text("printed_by_code"),
  printedByName: text("printed_by_name"),
  printedAt: timestamp("printed_at"),
  printCount: integer("print_count").default(0),
});

export const insertProformaSlipSchema = createInsertSchema(proformaSlips, {
  orderDate: z.union([z.date(), z.string()])
}).pick({
  orderDate: true, orderNumber: true, partyName: true, plant: true,
  totalQuantity: true, totalVolume: true, vehicleNumber: true, driverName: true,
  createdByCode: true, notes: true, isBackedUp: true, isPrintLocked: true,
  printedByCode: true, printedByName: true, printedAt: true, printCount: true,
});

// IMPORTANT: All fields below are IMMUTABLE SNAPSHOTS of product data at import
// time. They must NEVER be updated after the slip is created, even if the live
// product record changes later.
export const proformaSlipItems = pgTable("proforma_slip_items", {
  id: serial("id").primaryKey(),
  proformaSlipId: integer("proforma_slip_id").references(() => proformaSlips.id),
  productId: integer("product_id"), // soft reference only — display always uses snapshot fields below
  quantity: integer("quantity").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  srNo: text("sr_no"),
  itemNo: text("item_no"),
  barcode: text("barcode"),
  itemName: text("item_name"),
  category: text("category"),
  volumeInCuFt: text("volume_in_cu_ft"),
  hsnCode: text("hsn_code"),
  sapCode: text("sap_code"),
  description: text("description"),
  purchasePrice: text("purchase_price"),
  sellingPrice: text("selling_price"),
});

export const insertProformaSlipItemSchema = createInsertSchema(proformaSlipItems).pick({
  proformaSlipId: true, productId: true, quantity: true, srNo: true, itemNo: true,
  barcode: true, itemName: true, category: true, volumeInCuFt: true, hsnCode: true,
  sapCode: true, description: true, purchasePrice: true, sellingPrice: true,
});

export type ProformaSlip = typeof proformaSlips.$inferSelect;
export type InsertProformaSlip = z.infer<typeof insertProformaSlipSchema>;
export type ProformaSlipItem = typeof proformaSlipItems.$inferSelect;
export type InsertProformaSlipItem = z.infer<typeof insertProformaSlipItemSchema>;

// ============================================================================
// LOAD OPERATIONS  (GJ / Truck Loading Jobs)
// Purpose : Tracks a physical truck-loading job — which products are loaded
//           onto a vehicle against a proforma or standalone order.
//           Each operation has a header (vehicle, driver, party) and a list of
//           line items with loaded vs expected quantities.
// Used by : Load Operations page, GJ Operations.
// ============================================================================

export const loadingOperations = pgTable("load_operations", {
  id: serial("id").primaryKey(),
  status: text("status").default("in progress"), // "in progress" | "completed"
  referenceNumber: text("reference_number"),
  partyName: text("party_name"),       // dealer / recipient
  plant: text("plant"),
  vehicleNumber: text("vehicle_number"),
  driverName: text("driver_name"),
  createdByCode: text("created_by_code").references(() => users.userCode),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  orderDate: timestamp("order_date"),
  isBackedUp: boolean("is_backed_up").default(false),
});

export const insertLoadingOperationSchema = createInsertSchema(loadingOperations, {
  orderDate: z.union([z.date(), z.string()]).optional(),
  plant: z.string().optional(),
  partyName: z.string().optional(),
  driverName: z.string().optional(),
}).pick({
  status: true, referenceNumber: true, vehicleNumber: true, driverName: true,
  createdByCode: true, notes: true, orderDate: true, isBackedUp: true,
  plant: true, partyName: true,
});

// Line items for a load operation — tracks original qty, extra qty and how many were physically loaded
export const loadingOpItems = pgTable("load_operations_items", {
  id: serial("id").primaryKey(),
  loadOperationsId: integer("load_operations_id").references(() => loadingOperations.id),
  productId: integer("product_id").references(() => products.id),
  quantity: integer("quantity").default(0),             // total qty (proforma + extra)
  originalQuantity: integer("original_quantity"),       // qty from the original proforma
  extraQuantity: integer("extra_quantity").default(0),  // additional qty beyond the proforma
  loadedQuantity: integer("loaded_quantity").default(0),// qty physically confirmed loaded
  loaded: boolean("loaded").default(false),             // checkbox: fully loaded?
  createdAt: timestamp("created_at").defaultNow(),
  srNo: text("sr_no"),
  barcode: text("barcode"),
  itemName: text("item_name"),
  srNoDisplay: text("sr_no_display"), // formatted Sr.No. shown in the UI table
});

export const insertLoadingOpItemSchema = createInsertSchema(loadingOpItems).pick({
  loadOperationsId: true, productId: true, quantity: true, originalQuantity: true,
  extraQuantity: true, loadedQuantity: true, loaded: true, srNo: true,
  barcode: true, itemName: true, srNoDisplay: true,
});

// Backward-compatibility aliases (older code uses the "Mp" prefix)
export type MpOperation = typeof loadingOperations.$inferSelect;
export type MpOperationItem = typeof loadingOpItems.$inferSelect;
export type LoadingOperation = typeof loadingOperations.$inferSelect & {
  creatorName?: string;
  creatorUsername?: string;
  creatorRole?: string;
};
export type InsertLoadingOperation = z.infer<typeof insertLoadingOperationSchema>;
export type LoadingOpItem = typeof loadingOpItems.$inferSelect;
export type InsertLoadingOpItem = z.infer<typeof insertLoadingOpItemSchema>;
export type InsertMpOperation = InsertLoadingOperation;
export type InsertMpOperationItem = InsertLoadingOpItem;

// ============================================================================
// ORDERS  (Dealer Order Management)
// Purpose : Dealer orders created manually in the Order Management module.
//           An order can be converted into a Proforma Slip (sentToProforma flag).
//           Each order has a list of line items with quantities and prices.
// Used by : Order Management page (/order-management).
// ============================================================================

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  orderNumber: text("order_number").notNull(),
  dealer: text("dealer").notNull(),
  plant: text("plant"),
  vehicleNumber: text("vehicle_number"),
  orderDate: text("order_date").default(sql`(CURRENT_DATE)::text`), // defaults to today's date at insert time (stable SQL default — no migration churn)
  status: text("status").default("DRAFT"), // "DRAFT" | "CONFIRMED" | "DISPATCHED"
  createdByCode: text("created_by_code").references(() => users.userCode),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  notes: text("notes"),
  sentToProforma: boolean("sent_to_proforma").default(false),
  proformaId: integer("proforma_id"), // FK to proformaSlips once converted
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true, createdAt: true, updatedAt: true, sentToProforma: true, proformaId: true,
});

export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => products.id),
  srNo: text("sr_no"),
  name: text("name").notNull(),
  barcode: text("barcode"),
  quantity: integer("quantity").notNull().default(0),
  unitPrice: text("unit_price").default("0"),
  totalPrice: text("total_price"),
  category: text("category"),
  hsn: text("hsn"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertOrderItemSchema = createInsertSchema(orderItems).omit({
  id: true, createdAt: true, updatedAt: true,
});

export type Order = typeof orders.$inferSelect;
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type OrderItem = typeof orderItems.$inferSelect;
export type InsertOrderItem = z.infer<typeof insertOrderItemSchema>;

// ============================================================================
// PURCHASE ORDERS  (Excel-based Consolidated Dealer Orders)
// Purpose : Bulk dealer orders imported from Excel files. A single purchase
//           order covers multiple dealers and multiple products (a matrix).
//           Each cell in the matrix becomes one purchaseOrderItem row.
// Used by : Order Management / Purchases import flow.
// ============================================================================

export const purchaseOrders = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  orderDate: date("order_date").notNull(),
  deliveryDate: date("delivery_date"),
  status: text("status").default("pending"), // "pending" | "confirmed" | "processed" | "completed" | "cancelled"
  totalItems: integer("total_items").default(0),
  totalDealers: integer("total_dealers").default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  createdByCode: text("created_by_code").references(() => users.userCode),
});

export const insertPurchaseOrderSchema = createInsertSchema(purchaseOrders, {
  orderDate: z.union([z.date(), z.string()]),
  deliveryDate: z.union([z.date(), z.string()]).optional(),
}).pick({
  orderDate: true, deliveryDate: true, status: true, totalItems: true,
  totalDealers: true, notes: true, createdByCode: true,
});

// One row per (dealer × product) combination in the Excel matrix
export const purchaseOrderItems = pgTable("purchase_order_items", {
  id: serial("id").primaryKey(),
  purchaseOrderId: integer("purchase_order_id").references(() => purchaseOrders.id),
  dealerName: text("dealer_name").notNull(),
  vehicleNumber: text("vehicle_number"),
  driverName: text("driver_name"),
  productId: integer("product_id").references(() => products.id),
  productCode: text("product_code"),
  productName: text("product_name"),
  barcode: text("barcode"),
  quantity: integer("quantity").default(0),
  unitPrice: text("unit_price"),
  totalPrice: text("total_price"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPurchaseOrderItemSchema = createInsertSchema(purchaseOrderItems).pick({
  purchaseOrderId: true, dealerName: true, vehicleNumber: true, driverName: true,
  productId: true, productCode: true, productName: true, barcode: true,
  quantity: true, unitPrice: true, totalPrice: true, notes: true,
});

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type InsertPurchaseOrder = z.infer<typeof insertPurchaseOrderSchema>;
export type PurchaseOrderItem = typeof purchaseOrderItems.$inferSelect;
export type InsertPurchaseOrderItem = z.infer<typeof insertPurchaseOrderItemSchema>;

// Aliases used by the frontend (historical naming convention)
export type DealerPurchaseOrder = PurchaseOrder;
export type InsertDealerPurchaseOrder = InsertPurchaseOrder;
export type DealerPurchaseOrderItem = PurchaseOrderItem;
export type InsertDealerPurchaseOrderItem = InsertPurchaseOrderItem;

// ============================================================================
// PURCHASES  (Manual Stock Purchase Log)
// Purpose : Simple log of stock purchases entered manually by a user.
//           Not to be confused with purchaseOrders (Excel import).
//           These entries are used to increase inStock on the product.
// Used by : Purchases page (/purchases).
// ============================================================================

export const purchases = pgTable("purchases", {
  id: serial("id").primaryKey(),
  date: date("date").defaultNow(),
  item: text("item").notNull(),
  quantity: integer("quantity").default(0),
  priceDetails: text("price_details"),
  notes: text("notes"),
  userCode: text("user_code").references(() => users.userCode),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPurchaseSchema = createInsertSchema(purchases, {
  date: z.union([z.date(), z.string()])
}).pick({
  date: true, item: true, quantity: true, priceDetails: true,
  notes: true, userCode: true,
});

export type Purchase = typeof purchases.$inferSelect;
export type InsertPurchase = z.infer<typeof insertPurchaseSchema>;

// ============================================================================
// PLANTS  (Warehouse / Location Settings)
// Purpose : Configurable plant/warehouse locations. Each plant has display
//           colours for UI branding and feature flags (print-lock, split pages).
//           STVs (sub-transfer voucher codes) are linked to a plant via plantStvs.
// Used by : Plant Settings page (/plant-settings), Proforma Slips, Load Operations.
// ============================================================================

export const plants = pgTable("plants", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  bgColor: text("bg_color").notNull(),
  textColor: text("text_color").notNull(),
  borderColor: text("border_color").notNull(),
  // Short code for the Indian state this plant is in (e.g. "GJ", "MP") — drives which
  // per-state column on products (gjPlt/mpPlt) a scan against this plant reads. Nullable so
  // existing plants aren't broken until an admin fills it in on the Plant Management page.
  state: text("state"),
  isLockingEnabled: boolean("is_locking_enabled").default(true),      // lock proforma after first print
  isSplitPagesEnabled: boolean("is_split_pages_enabled").default(false), // split print across pages
  // Order Scan: auto-complete a part the instant every item on it is fully scanned, instead
  // of requiring an admin to click Complete. OFF by default so existing plants keep today's
  // fully-manual behavior until an admin opts in. Even when ON, the LAST part of a FIFO
  // group (or a standalone import) never auto-completes — see the last-part check in
  // order-scan.ts's /scan handler.
  isAutoCompleteEnabled: boolean("is_auto_complete_enabled").default(false),
  // Order Scan: when ON, a scan whose remaining order qty is a FULL pallet or more is
  // confirmed automatically (one pallet per scan) with a 5s image feedback popup and no
  // dialog; only a leftover "loose" amount (less than a full pallet) opens the confirm
  // dialog. OFF by default → every scan opens the confirm dialog. See _resolveOsScan in
  // client/src/pages/Scanning/Scan.tsx.
  isAutoScanEnabled: boolean("is_auto_scan_enabled").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPlantSchema = createInsertSchema(plants).pick({
  name: true, bgColor: true, textColor: true, borderColor: true, state: true,
  isLockingEnabled: true, isSplitPagesEnabled: true, isAutoCompleteEnabled: true,
  isAutoScanEnabled: true,
});

// STV codes associated with a plant (e.g. for truck/dispatch routing)
export const plantStvs = pgTable("plant_stvs", {
  id: serial("id").primaryKey(),
  plantId: integer("plant_id").references(() => plants.id, { onDelete: "cascade" }),
  stv: text("stv").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPlantStvSchema = createInsertSchema(plantStvs).pick({
  plantId: true, stv: true,
});

export type Plant = typeof plants.$inferSelect;
export type InsertPlant = typeof plants.$inferInsert;
export type PlantStv = typeof plantStvs.$inferSelect;
export type InsertPlantStv = z.infer<typeof insertPlantStvSchema>;

// ============================================================================
// VEHICLE INFO
// Purpose : Registry of company vehicles with their RTO numbers.
//           Provides an autocomplete source for the vehicle number field
//           in Proforma Slips and Load Operations.
// Used by : Proforma Slips page, Load Operations page, Settings.
// ============================================================================

export const vehicleInfo = pgTable("vehicle_info", {
  id: serial("id").primaryKey(),
  srNo: integer("sr_no").notNull(),
  rtoNumber: text("rto_number").notNull(),
  vehicleNumber: text("vehicle_number").notNull().unique(),
  lastEditedByCode: text("last_edited_by_code").references(() => users.userCode),
  lastEditedAt: timestamp("last_edited_at").defaultNow(),
  createdByCode: text("created_by_code").references(() => users.userCode),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertVehicleInfoSchema = createInsertSchema(vehicleInfo).pick({
  srNo: true, rtoNumber: true, vehicleNumber: true,
  lastEditedByCode: true, createdByCode: true,
});

export type VehicleInfo = typeof vehicleInfo.$inferSelect;
export type InsertVehicleInfo = z.infer<typeof insertVehicleInfoSchema>;

// ============================================================================
// MESSAGES  (Internal Messaging / Broadcasts)
// Purpose : In-app messaging between employees. Supports direct messages
//           and broadcasts to all users, a specific designation, or a
//           specific department.
// Used by : Messages page (/messages).
// ============================================================================

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  senderCode: text("sender_code").notNull(),       // userCode of the sender
  recipientCode: text("recipient_code"),            // userCode of the recipient (null for broadcasts)
  content: text("content").notNull(),
  isRead: boolean("is_read").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  broadcastToAll: boolean("broadcast_to_all").default(false),
  broadcastToDesignation: text("broadcast_to_designation"), // target a specific job title
  broadcastToDepartment: text("broadcast_to_department"),   // target a specific department
});

export const insertMessageSchema = createInsertSchema(messages).pick({
  senderCode: true, recipientCode: true, content: true, isRead: true,
  broadcastToAll: true, broadcastToDesignation: true, broadcastToDepartment: true,
});

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

// ============================================================================
// VOUCHER PREFIXES
// Purpose : Configurable number prefixes for expense and toll vouchers.
//           e.g. prefix "EXP-" → voucher numbers become "EXP-001", "EXP-002".
// Used by : Expense Voucher page, Toll Voucher page, Settings.
// ============================================================================

export const voucherPrefixes = pgTable("voucher_prefixes", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),    // "expense" | "toll"
  prefix: text("prefix").notNull(),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertVoucherPrefixSchema = createInsertSchema(voucherPrefixes).pick({
  type: true, prefix: true, updatedBy: true,
});

export type VoucherPrefix = typeof voucherPrefixes.$inferSelect;
export type InsertVoucherPrefix = z.infer<typeof insertVoucherPrefixSchema>;

// ============================================================================
// ORDER IMPORT  (CSV-based Order Import — new flow, separate from legacy orders)
// Purpose : Allows admin to upload a CSV order file, map CSV columns to the
//           fixed schema (barcode, item name, SAP code, quantity, pallets),
//           and persist the rows into the database grouped by import session.
// Used by : Order Import page (/order-import, admin only).
// ============================================================================

export const orderImportSessions = pgTable("order_import_sessions", {
  id: serial("id").primaryKey(),
  plant: text("plant").notNull(),
  csvFileName: text("csv_file_name").notNull(),
  rowCount: integer("row_count").default(0),
  importedByCode: text("imported_by_code").references(() => users.userCode),
  createdAt: timestamp("created_at").defaultNow(),
  // Scan tracking
  scanStatus: text("scan_status").default("available"), // available | active | completed
  scanActivatedByCode: text("scan_activated_by_code").references(() => users.userCode),
  scanActivatedAt: timestamp("scan_activated_at"),
  scanCompletedAt: timestamp("scan_completed_at"),
  // FIFO grouping is automatic by (plant + order date): every CSV uploaded for the same
  // plant and order date shares one receivingSessionId (the group's Part 1 uses its own id
  // as the group id) and gets the next partIndex. orderDate is the "Order Date" chosen at
  // upload (YYYY-MM-DD) — the grouping key, distinct from createdAt (the upload timestamp).
  orderDate: text("order_date"),
  receivingSessionId: integer("receiving_session_id"),
  partIndex: integer("part_index"),
  // Set once this part's received boxes have been added to products.in_stock, so stock is
  // never double-counted (e.g. a retried /complete). Stock is applied on terminal
  // completion — a standalone session on its own complete, a FIFO part when the whole
  // group finishes — using SUM(order_scan_events.total_qty) per barcode.
  stockAppliedAt: timestamp("stock_applied_at"),
  // Soft-delete: keeps scan_items/scan_events intact so history/reports survive
  isDeleted: boolean("is_deleted").default(false).notNull(),
  deletedAt: timestamp("deleted_at"),
  deletedByCode: text("deleted_by_code").references(() => users.userCode),
  // Delete-with-rollback replacement flow: a deleted session's scan history is never
  // discarded — it waits to be carried forward onto whichever CSV next fills the same
  // (plant, orderDate) slot. remappedToSessionId/remappedAt are set on THIS (deleted)
  // session once that happens; replacesSessionId is set on the NEW session, pointing back.
  remappedToSessionId: integer("remapped_to_session_id"),
  remappedAt: timestamp("remapped_at"),
  replacesSessionId: integer("replaces_session_id"),
});

export const orderImportItems = pgTable("order_import_items", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .references(() => orderImportSessions.id, { onDelete: "cascade" })
    .notNull(),
  barcode: text("barcode"),
  itemName: text("item_name"),
  sapCode: text("sap_code"),
  quantity: integer("quantity").default(0),
  expectedPallets: real("expected_pallets"),
  date: text("date"),
  plant: text("plant"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertOrderImportSessionSchema = createInsertSchema(orderImportSessions).pick({
  plant: true, csvFileName: true, rowCount: true, importedByCode: true,
  receivingSessionId: true, partIndex: true,
});

export const insertOrderImportItemSchema = createInsertSchema(orderImportItems).pick({
  sessionId: true, barcode: true, itemName: true, sapCode: true,
  quantity: true, expectedPallets: true, date: true, plant: true,
});

export type OrderImportSession = typeof orderImportSessions.$inferSelect;
export type InsertOrderImportSession = z.infer<typeof insertOrderImportSessionSchema>;
export type OrderImportItem = typeof orderImportItems.$inferSelect;
export type InsertOrderImportItem = z.infer<typeof insertOrderImportItemSchema>;

// ============================================================================
// ORDER SCAN  (Pallet scanning against an imported CSV order)
// Purpose : After a CSV is imported via Order Import, warehouse staff scan
//           each arriving box. One orderScanItem per CSV row tracks progress.
//           orderScanEvents is the per-scan audit trail.
// Used by : Order Scan page (/order-scan).
// ============================================================================

export const orderScanItems = pgTable("order_scan_items", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .references(() => orderImportSessions.id, { onDelete: "cascade" })
    .notNull(),
  orderImportItemId: integer("order_import_item_id")
    .references(() => orderImportItems.id, { onDelete: "set null" }),
  barcode: text("barcode"),
  itemName: text("item_name"),
  sapCode: text("sap_code"),
  expectedQty: integer("expected_qty").default(0),
  itemsPerPallet: integer("items_per_pallet").default(0), // plant-specific snapshot at activation
  scannedPallets: real("scanned_pallets").default(0),
  scannedLooseQty: integer("scanned_loose_qty").default(0),
  totalScannedQty: integer("total_scanned_qty").default(0),
  status: text("status").default("pending"), // pending | partial | complete
  lastScannedAt: timestamp("last_scanned_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const orderScanEvents = pgTable("order_scan_events", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .references(() => orderImportSessions.id, { onDelete: "cascade" })
    .notNull(),
  scanItemId: integer("scan_item_id")
    .references(() => orderScanItems.id, { onDelete: "set null" }),
  barcode: text("barcode").notNull(),
  itemName: text("item_name"),
  pallets: real("pallets").default(0),
  looseQty: integer("loose_qty").default(0),
  totalQty: integer("total_qty").default(0),
  itemsPerPallet: integer("items_per_pallet").default(0),
  isExtra: boolean("is_extra").default(false),
  stv: text("stv"),
  scannedByCode: text("scanned_by_code").references(() => users.userCode),
  scannedByName: text("scanned_by_name"),
  scannedAt: timestamp("scanned_at").defaultNow(),
  // Added via a raw ALTER TABLE migration in server/index.ts on server startup, not through
  // Drizzle — declared here so drizzle-kit push/generate stop treating it as drift to drop.
  // Used by the Notion sync feature (server/routes/scan-sessions.ts) to track which scan
  // events have already been pushed to Notion.
  notionSyncedAt: timestamp("notion_synced_at", { withTimezone: true }),
  // Admin-only "void" — marks a mistaken scan so it's excluded from live totals/stock while
  // staying in history for audit. Never physically deleted. Only allowed while the parent
  // session is still active (not yet completed, since stock is already finalized by then).
  voided: boolean("voided").default(false),
  voidedByCode: text("voided_by_code").references(() => users.userCode),
  voidedAt: timestamp("voided_at"),
  voidReason: text("void_reason"),
  // How much of THIS extra event's qty has already been handed over to a later part's
  // shortfall for the same barcode, via the credit-reconciliation step that runs when a
  // part completes (see reconcileCredits in server/lib/orderGroupReport.ts). Only ever
  // set on is_extra=true rows; caps the amount available to credit anything else so the
  // same physical boxes can't be credited twice. 0 for ordinary (non-extra) events.
  creditedQty: integer("credited_qty").default(0),
  // Marks a row as a SYSTEM-GENERATED credit transfer (written by reconcileCredits in
  // server/lib/orderGroupReport.ts), not a real physical scan — it never added new stock, it
  // just reassigns boxes an earlier part's Extra scan already added. Void must skip the stock
  // reversal for these rows (there's nothing to reverse) and instead give the qty back to the
  // source event via creditSourceEventId, or it double-removes real stock. Added via a raw
  // ALTER TABLE migration in server/index.ts, like notionSyncedAt above.
  isCredit: boolean("is_credit").default(false),
  creditSourceEventId: integer("credit_source_event_id"),
  // "Empty Box" manual entry (a box with no item/barcode to scan) reuses THIS table's existing
  // columns instead of dedicated flags: it's an event with the sentinel barcode 'EMPTY_BOX'
  // (how every read identifies one — no real numeric SKU collides), its count in total_qty,
  // is_extra=false and scan_item_id=null (so received/extra/stock totals never see it), and its
  // item_name holding the label + optional note ('Empty Box' or 'Empty Box: <note>').
});

export const insertOrderScanItemSchema = createInsertSchema(orderScanItems).pick({
  sessionId: true, orderImportItemId: true, barcode: true, itemName: true,
  sapCode: true, expectedQty: true, itemsPerPallet: true,
});

export const insertOrderScanEventSchema = createInsertSchema(orderScanEvents).pick({
  sessionId: true, scanItemId: true, barcode: true, itemName: true,
  pallets: true, looseQty: true, totalQty: true, itemsPerPallet: true,
  isExtra: true, stv: true, scannedByCode: true, scannedByName: true,
});

export type OrderScanItem = typeof orderScanItems.$inferSelect;
export type InsertOrderScanItem = z.infer<typeof insertOrderScanItemSchema>;
export type OrderScanEvent = typeof orderScanEvents.$inferSelect;
export type InsertOrderScanEvent = z.infer<typeof insertOrderScanEventSchema>;

// ============================================================================
// ACTIVITIES  (Global Audit Log)
// Purpose : Records every significant user action across all pages — creates,
//           updates, deletes, prints, etc. Used for the Activities admin page
//           and compliance auditing.
// Used by : Activities page (/activities, admin only). Written from almost
//           every route handler via a shared helper.
// ============================================================================

export const activities = pgTable("activities", {
  id: serial("id").primaryKey(),
  pageName: text("page_name").notNull(),    // which page triggered this event
  action: text("action").notNull(),          // "create" | "update" | "delete" | "print" | etc.
  entityType: text("entity_type").notNull(), // "product" | "slip" | "order" | etc.
  entityId: text("entity_id"),               // ID of the affected record
  details: text("details"),                  // extra JSON metadata about the change
  userCode: text("user_code").references(() => users.userCode),
  userName: text("user_name"),               // cached for fast display without a join
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertActivitySchema = createInsertSchema(activities).pick({
  pageName: true, action: true, entityType: true, entityId: true,
  details: true, userCode: true, userName: true,
});

export type Activity = typeof activities.$inferSelect;
export type InsertActivity = z.infer<typeof insertActivitySchema>;

// ============================================================================
// AUTH SESSION  (Express-session Store)
// Purpose : Stores server-side HTTP sessions for express-session using the
//           connect-pg-simple PostgreSQL store. Each row is one active login
//           session. Rows expire automatically via the `expire` timestamp.
// Managed by : connect-pg-simple (do NOT write to this table manually).
// ============================================================================

export const session = pgTable("session", {
  sid: text("sid").primaryKey(),
  sess: text("sess").notNull(), // serialised JSON session data
  expire: timestamp("expire").notNull(),
});

// ============================================================================
// BACKUP TABLES  (Historical / Archived Data)
// Purpose : When a backup job runs, completed records are copied from the live
//           tables into these backup tables and the live rows are marked
//           isBackedUp = true.  This keeps the live tables lean while
//           preserving full history.
//
// backup_settings        — configures how often auto-backup runs
// scan_history_backup    — archived rows from scan_history
// proforma_slips_backup  — archived rows from proforma_slips
// proforma_slip_items_backup — archived rows from proforma_slip_items
// load_operations_backup     — archived rows from load_operations
// load_operations_items_backup — archived rows from load_operations_items
// ============================================================================

export const backupSettings = pgTable("backup_settings", {
  id: serial("id").primaryKey(),
  lastBackupDate: timestamp("last_backup_date").defaultNow(),
  autoBackupEnabled: boolean("auto_backup_enabled").default(true),
  backupFrequencyHours: integer("backup_frequency_hours").default(24),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertBackupSettingsSchema = createInsertSchema(backupSettings).pick({
  lastBackupDate: true, autoBackupEnabled: true, backupFrequencyHours: true,
});

export type BackupSettings = typeof backupSettings.$inferSelect;
export type InsertBackupSettings = z.infer<typeof insertBackupSettingsSchema>;

export const scanHistoryBackup = pgTable("scan_history_backup", {
  id: serial("id").primaryKey(),
  originalId: integer("original_id"),
  barcode: text("barcode").notNull(),
  productId: integer("product_id"),
  productName: text("product_name"),
  productSku: text("product_sku"),
  scannedByCode: text("scanned_by_code"),
  scannerName: text("scanner_name"),
  scannerDepartment: text("scanner_department"),
  scannedAt: timestamp("scanned_at"),
  action: text("action"),
  quantity: integer("quantity"),
  notes: text("notes"),
  backupDate: timestamp("backup_date").defaultNow(),
});

export const proformaSlipsBackup = pgTable("proforma_slips_backup", {
  id: serial("id").primaryKey(),
  originalId: integer("original_id"),
  orderDate: date("order_date"),
  orderNumber: text("order_number"),
  partyName: text("party_name"),
  plant: text("plant"),
  totalQuantity: integer("total_quantity"),
  totalVolume: text("total_volume"),
  vehicleNumber: text("vehicle_number"),
  driverName: text("driver_name"),
  createdById: integer("created_by_id"),
  createdAt: timestamp("created_at"),
  notes: text("notes"),
  backupDate: timestamp("backup_date").defaultNow(),
});

export const proformaSlipItemsBackup = pgTable("proforma_slip_items_backup", {
  id: serial("id").primaryKey(),
  originalId: integer("original_id"),
  proformaSlipId: integer("proforma_slip_id"),
  proformaSlipBackupId: integer("proforma_slip_backup_id"),
  productId: integer("product_id"),
  quantity: integer("quantity"),
  srNo: text("sr_no"),
  barcode: text("barcode"),
  itemName: text("item_name"),
  createdAt: timestamp("created_at"),
  backupDate: timestamp("backup_date").defaultNow(),
});

export const loadingOpItemsBackup = pgTable("load_operations_items_backup", {
  id: serial("id").primaryKey(),
  originalId: integer("original_id"),
  loadOperationsId: integer("load_operations_id"),
  productId: integer("product_id"),
  quantity: integer("quantity").default(0),
  originalQuantity: integer("original_quantity"),
  extraQuantity: integer("extra_quantity").default(0),
  loadedQuantity: integer("loaded_quantity").default(0),
  loaded: boolean("loaded").default(false),
  srNo: text("sr_no"),
  barcode: text("barcode"),
  itemName: text("item_name"),
  createdAt: timestamp("created_at"),
  backupDate: timestamp("backup_date").defaultNow(),
});

export const loadingOperationsBackup = pgTable("load_operations_backup", {
  id: serial("id").primaryKey(),
  originalId: integer("original_id"),
  status: text("status"),
  referenceNumber: text("reference_number"),
  partyName: text("party_name"),
  plant: text("plant"),
  vehicleNumber: text("vehicle_number"),
  driverName: text("driver_name"),
  createdById: integer("created_by_id"),
  createdAt: timestamp("created_at"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  orderDate: timestamp("order_date"),
  backupDate: timestamp("backup_date").defaultNow(),
});

export type ScanHistoryBackup = typeof scanHistoryBackup.$inferSelect;
export type LoadingOpItemBackup = typeof loadingOpItemsBackup.$inferSelect;
export type LoadingOperationBackup = typeof loadingOperationsBackup.$inferSelect;
export type ProformaSlipBackup = typeof proformaSlipsBackup.$inferSelect;
export type ProformaSlipItemBackup = typeof proformaSlipItemsBackup.$inferSelect;

// ============================================================================
// PRODUCT PLANT STOCK  — plant-wise running stock totals
// Purpose : One row per (barcode, plant). The live plant-wise stock count.
//           inStock = all boxes physically received for that plant (extras
//           included). extraQty = how many of those arrived beyond the ordered
//           quantity (shown separately in Overall Stock, never hidden/netted).
//           Written by applySessionStock() on order completion; global
//           products.in_stock stays the all-plants sum for backward compat.
// Design  : Additive today (receiving only). A future dispatch/out flow will
//           decrement inStock and log a negative stock_movements row — the
//           table shape already supports that with no rework.
// ============================================================================
export const productPlantStock = pgTable("product_plant_stock", {
  id: serial("id").primaryKey(),
  barcode: text("barcode").notNull(),
  plant: text("plant").notNull(),
  inStock: integer("in_stock").default(0).notNull(),
  extraQty: integer("extra_qty").default(0).notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => ({
  uniqBarcodePlant: unique("uq_product_plant_stock_barcode_plant").on(t.barcode, t.plant),
}));

// ============================================================================
// STOCK MOVEMENTS  — append-only ledger of every change to plant stock
// Purpose : Full in/out history per plant. qty is +received (today) and will be
//           −dispatched once the future out-flow is added. Gives an audit trail
//           and makes future subtraction trivial (just insert a negative row).
// ============================================================================
export const stockMovements = pgTable("stock_movements", {
  id: serial("id").primaryKey(),
  barcode: text("barcode").notNull(),
  plant: text("plant").notNull(),
  qty: integer("qty").notNull(),                 // +received / −sent (future)
  extraQty: integer("extra_qty").default(0),     // portion of qty that was extra (over-order)
  type: text("type").notNull(),                  // 'receive' | 'dispatch' | 'adjust' | 'exchange'
  reason: text("reason"),
  sessionId: integer("session_id"),              // order_import_sessions.id when from a scan completion
  createdByCode: text("created_by_code"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type ProductPlantStock = typeof productPlantStock.$inferSelect;
export type StockMovement = typeof stockMovements.$inferSelect;
