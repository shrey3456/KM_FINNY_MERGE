import { pgTable, text, serial, integer, boolean, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Activities schema to track all user actions in the app
export const activities = pgTable("activities", {
  id: serial("id").primaryKey(),
  pageName: text("page_name").notNull(), // Which page generated this activity
  action: text("action").notNull(), // The action performed (e.g., "create", "update", "delete")
  entityType: text("entity_type").notNull(), // Type of entity affected (e.g., "product", "slip", "sale")
  entityId: text("entity_id"), // ID or reference of the affected entity
  details: text("details"), // Additional details about the activity in JSON format
  userCode: text("user_code").references(() => users.userCode), // Who performed the action
  userName: text("user_name"), // Cache the user name for quick display
  createdAt: timestamp("created_at").defaultNow(), // When the action occurred
});

export const insertActivitySchema = createInsertSchema(activities).pick({
  pageName: true,
  action: true,
  entityType: true,
  entityId: true,
  details: true,
  userCode: true,
  userName: true,
});

// Load Operations schema
export const loadingOperations = pgTable("load_operations", {
  id: serial("id").primaryKey(),
  status: text("status").default("in progress"),
  referenceNumber: text("reference_number"),
  partyName: text("party_name"), // Party name (dealer) field, imported from proforma slip - moved up after referenceNumber
  plant: text("plant"), // Plant field for location information - moved up after partyName
  vehicleNumber: text("vehicle_number"), // Added vehicle number field to match proforma slips
  driverName: text("driver_name"), // Added driver name field for complete independence from proforma slips
  createdByCode: text("created_by_code").references(() => users.userCode),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  orderDate: timestamp("order_date"), // Added order date field to match proforma slips
  isBackedUp: boolean("is_backed_up").default(false), // Flag to indicate if this record has been backed up
});

export const insertLoadingOperationSchema = createInsertSchema(loadingOperations, {
  // Override the orderDate field to accept both Date and string
  orderDate: z.union([z.date(), z.string()]).optional(),
  // Add plant field validation
  plant: z.string().optional(),
  // Add party name validation
  partyName: z.string().optional(),
  // Add driver name validation
  driverName: z.string().optional()
}).pick({
  status: true,
  referenceNumber: true,
  vehicleNumber: true,
  driverName: true,
  createdByCode: true,
  notes: true,
  orderDate: true,
  isBackedUp: true,
  plant: true,
  partyName: true,
});

// GJ Operations Items schema (previously Loading Operation Items)
export const loadingOpItems = pgTable("load_operations_items", { //Renamed table
  id: serial("id").primaryKey(),
  loadOperationsId: integer("load_operations_id").references(() => loadingOperations.id), // Consistent field name
  productId: integer("product_id").references(() => products.id),
  quantity: integer("quantity").default(0), // Total quantity (proforma + extra)
  originalQuantity: integer("original_quantity"), // Track the original proforma quantity
  extraQuantity: integer("extra_quantity").default(0), // Track extra quantity beyond proforma
  loadedQuantity: integer("loaded_quantity").default(0), // Track how many items were actually loaded
  loaded: boolean("loaded").default(false), // Track whether the item has been loaded (checkbox state) - moved after loaded_quantity
  createdAt: timestamp("created_at").defaultNow(),
  srNo: text("sr_no"), // Serial number for the item
  barcode: text("barcode"), // Barcode for the item
  itemName: text("item_name"), // Name of the item
  srNoDisplay: text("sr_no_display"), // Display field for Sr.No. column in UI
});

// Create the insert schema
export const insertLoadingOpItemSchema = createInsertSchema(loadingOpItems).pick({
  loadOperationsId: true,
  productId: true,
  quantity: true,
  originalQuantity: true,
  extraQuantity: true, // Added extra quantity field
  loadedQuantity: true,
  loaded: true,
  srNo: true,
  barcode: true,
  itemName: true,
  srNoDisplay: true,
});

// Create type aliases for MP Operations for backward compatibility 
// with existing code that uses the MP prefix
export type MpOperation = typeof loadingOperations.$inferSelect;
export type MpOperationItem = typeof loadingOpItems.$inferSelect;
export type InsertMpOperation = InsertLoadingOperation;
export type InsertMpOperationItem = InsertLoadingOpItem;

// Purchase schema
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
  // Override the date field to accept both Date and string for DD-MM-YYYY format
  date: z.union([z.date(), z.string()])
}).pick({
  date: true,
  item: true,
  quantity: true,
  priceDetails: true,
  notes: true,
  userCode: true,
});


// User schema
export const users = pgTable("users", {
  userCode: text("user_code").primaryKey().notNull(), // User ID number for employee identification - primary key
  username: text("username").notNull().unique(),
  pin: text("pin").notNull(), // Changed from password to pin
  name: text("name"),
  designation: text("designation"),
  department: text("department"),
  role: text("role").default("user"),
  profileImage: text("profile_image"), // Base64 encoded profile image
});

// Recreate the insert schema with the new pin field
export const insertUserSchema = createInsertSchema(users);

// Product schema
export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  srNo: text("sr_no"), // Sr. No. from CSV
  itemNo: text("item_no"), // SKU or internal item number
  barcode: text("barcode").notNull().unique(),
  name: text("name").notNull(),
  category: text("category"),
  volumeInCuFt: text("volume_in_cu_ft"), // Cu. ft. volume
  hsnCode: text("hsn_code"),
  sapCode: text("sap_code"),
  purchased: integer("purchased").default(0),
  sold: integer("sold").default(0),
  inStock: integer("in_stock").default(0),
  itemsPerPallet: integer("items_per_pallet").default(0),
  pallets: integer("pallets").default(0),
  purchasePrice: text("purchase_price"),
  sellingPrice: text("selling_price"),
  lastUpdated: timestamp("last_updated"),
  description: text("description"),
  status: text("status").default("in stock"),
  createdByCode: text("created_by_code").references(() => users.userCode),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertProductSchema = createInsertSchema(products, {
  // Override the lastUpdated field to accept both Date and string
  lastUpdated: z.union([z.date(), z.string()]).optional(),
}).pick({
  srNo: true,
  itemNo: true,
  barcode: true,
  name: true,
  category: true,
  volumeInCuFt: true,
  hsnCode: true,
  sapCode: true,
  purchased: true,
  sold: true,
  inStock: true,
  itemsPerPallet: true,
  pallets: true,
  purchasePrice: true,
  sellingPrice: true,
  lastUpdated: true,
  description: true,
  status: true,
  createdByCode: true,
});

// Scan history schema
export const scanHistory = pgTable("scan_history", {
  id: serial("id").primaryKey(),
  barcode: text("barcode").notNull(),
  productId: integer("product_id").references(() => products.id),
  scannedByCode: text("scanned_by_code").references(() => users.userCode),
  scannedAt: timestamp("scanned_at").defaultNow(),
  action: text("action").notNull(), // e.g., "add", "remove", "update"
  quantity: integer("quantity").default(1),
  notes: text("notes"),
  productSku: text("product_sku"), // Added to support SKU in scan history
  scannerName: text("scanner_name"), // User's display name who scanned the barcode
  scannerDepartment: text("scanner_department"), // User's department
  productName: text("product_name"), // Store the product name for better historical records
  isBackedUp: boolean("is_backed_up").default(false), // Flag to indicate if this record has been backed up
  orderNumber: text("order_number"), // Reference to associated order number
});

export const insertScanHistorySchema = createInsertSchema(scanHistory).pick({
  barcode: true,
  productId: true,
  scannedByCode: true,
  action: true,
  quantity: true,
  notes: true,
  productSku: true,
  scannerName: true,
  scannerDepartment: true,
  productName: true,
  isBackedUp: true,
  orderNumber: true,
});

// Types for frontend and backend use
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Product = typeof products.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;

export type ScanHistory = typeof scanHistory.$inferSelect;
export type InsertScanHistory = z.infer<typeof insertScanHistorySchema>;

export type Purchase = typeof purchases.$inferSelect;
export type InsertPurchase = z.infer<typeof insertPurchaseSchema>;


export type LoadingOperation = typeof loadingOperations.$inferSelect & {
  creatorName?: string;
  creatorUsername?: string;
  creatorRole?: string;
};
export type InsertLoadingOperation = z.infer<typeof insertLoadingOperationSchema>;

export type LoadingOpItem = typeof loadingOpItems.$inferSelect;
export type InsertLoadingOpItem = z.infer<typeof insertLoadingOpItemSchema>;


// Extended schemas for validation
export const scanEntrySchema = z.object({
  barcode: z.string().min(1, "Barcode is required"),
  quantity: z.number().int().positive().default(1),
  name: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  action: z.enum(["add", "remove", "update"]).default("add"),
  notes: z.string().optional(),
  productId: z.number().optional(), // Added to support direct product reference
  productSku: z.string().optional(), // Added to support SKU display in scan history
  scannerName: z.string().optional(), // User's display name who scanned the barcode
  scannerDepartment: z.string().optional(), // User's department
  scannedByCode: z.string().optional(), // The user code of who performed the scan
  productName: z.string().optional(), // Store the product name for better historical records
  isBackedUp: z.boolean().optional(), // Flag to indicate if this record has been backed up
  orderNumber: z.string().optional(), // Reference to the order number for matching with load operations
});

export type ScanEntry = z.infer<typeof scanEntrySchema>;

// Proforma Slip schema
export const proformaSlips = pgTable("proforma_slips", {
  id: serial("id").primaryKey(),
  orderDate: date("order_date").defaultNow(),
  orderNumber: text("order_number").notNull(),
  partyName: text("party_name").notNull(),
  plant: text("plant"),
  totalQuantity: integer("total_quantity").default(0),
  totalVolume: text("total_volume"),
  vehicleNumber: text("vehicle_number"),
  driverName: text("driver_name"),
  createdByCode: text("created_by_code").references(() => users.userCode),
  createdAt: timestamp("created_at").defaultNow(),
  notes: text("notes"),
  isBackedUp: boolean("is_backed_up").default(false),
   // Flag to indicate if this record has been backed up
   isPrintLocked: boolean("is_print_locked").default(false),
  printedByCode: text("printed_by_code"),
  printedByName: text("printed_by_name"),
  printedAt: timestamp("printed_at"),
  printCount: integer("print_count").default(0),
});

export const insertProformaSlipSchema = createInsertSchema(proformaSlips, {
  // Override the orderDate field to accept both Date and string for DD-MM-YYYY format
  orderDate: z.union([z.date(), z.string()])
}).pick({
  orderDate: true,
  orderNumber: true,
  partyName: true,
  plant: true,
  totalQuantity: true,
  totalVolume: true,
  vehicleNumber: true,
  driverName: true,
  createdByCode: true,
  notes: true,
  isBackedUp: true,
  isPrintLocked: true,
  printedByCode: true,
  printedByName: true,
  printedAt: true,
  printCount: true,
});

// Proforma Slip Items schema
// IMPORTANT: This table stores IMMUTABLE SNAPSHOTS of product data at import time
// These fields should NEVER be updated after import, even if inventory changes
export const proformaSlipItems = pgTable("proforma_slip_items", {
  id: serial("id").primaryKey(),
  proformaSlipId: integer("proforma_slip_id").references(() => proformaSlips.id),
  productId: integer("product_id"), // Optional reference - NOT used for display, data comes from CSV snapshots
  quantity: integer("quantity").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  // Snapshot fields: Store complete product data at import time to ensure immutability
  // ALL DATA comes from CSV - NO inventory lookup
  srNo: text("sr_no"), // Serial number for the item
  itemNo: text("item_no"), // SKU or internal item number (snapshot)
  barcode: text("barcode"), // Barcode for the item (snapshot)
  itemName: text("item_name"), // Name of the item (snapshot)
  category: text("category"), // Product category (snapshot)
  volumeInCuFt: text("volume_in_cu_ft"), // Cu. ft. volume (snapshot)
  hsnCode: text("hsn_code"), // HSN code (snapshot)
  sapCode: text("sap_code"), // SAP code (snapshot)
  description: text("description"), // Product description (snapshot)
  purchasePrice: text("purchase_price"), // Purchase price at import time (snapshot)
  sellingPrice: text("selling_price"), // Selling price at import time (snapshot)
});

export const insertProformaSlipItemSchema = createInsertSchema(proformaSlipItems).pick({
  proformaSlipId: true,
  productId: true,
  quantity: true,
  srNo: true,
  itemNo: true,
  barcode: true,
  itemName: true,
  category: true,
  volumeInCuFt: true,
  hsnCode: true,
  sapCode: true,
  description: true,
  purchasePrice: true,
  sellingPrice: true,
});

export type ProformaSlip = typeof proformaSlips.$inferSelect;
export type InsertProformaSlip = z.infer<typeof insertProformaSlipSchema>;

export type ProformaSlipItem = typeof proformaSlipItems.$inferSelect;
export type InsertProformaSlipItem = z.infer<typeof insertProformaSlipItemSchema>;

// Vehicle Info schema
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
  srNo: true,
  rtoNumber: true, 
  vehicleNumber: true,
  lastEditedByCode: true,
  createdByCode: true,
});

export type VehicleInfo = typeof vehicleInfo.$inferSelect;
export type InsertVehicleInfo = z.infer<typeof insertVehicleInfoSchema>;

// Purchase Orders schema (for Excel-based consolidated dealer orders)
export const purchaseOrders = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  orderDate: date("order_date").notNull(), // The order date from Excel (e.g., 18/09/2025)
  deliveryDate: date("delivery_date"), // Delivery date if different from order date
  status: text("status").default("pending"), // pending, confirmed, processed, completed, cancelled
  totalItems: integer("total_items").default(0), // Total number of items across all dealers
  totalDealers: integer("total_dealers").default(0), // Number of dealers participating
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  createdByCode: text("created_by_code").references(() => users.userCode),
});

export const insertPurchaseOrderSchema = createInsertSchema(purchaseOrders, {
  orderDate: z.union([z.date(), z.string()]),
  deliveryDate: z.union([z.date(), z.string()]).optional(),
}).pick({
  orderDate: true,
  deliveryDate: true,
  status: true,
  totalItems: true,
  totalDealers: true,
  notes: true,
  createdByCode: true,
});


// Purchase Order Items schema (product-dealer-quantity matrix)
export const purchaseOrderItems = pgTable("purchase_order_items", {
  id: serial("id").primaryKey(),
  purchaseOrderId: integer("purchase_order_id").references(() => purchaseOrders.id),
  dealerName: text("dealer_name").notNull(), // Dealer/customer name from Excel
  vehicleNumber: text("vehicle_number"), // Assigned vehicle number
  driverName: text("driver_name"), // Driver name if available
  productId: integer("product_id").references(() => products.id),
  productCode: text("product_code"), // Product code from Excel (e.g., "100215")
  productName: text("product_name"), // Product name for reference
  barcode: text("barcode"), // Product barcode for reference
  quantity: integer("quantity").default(0), // Quantity this dealer ordered for this product
  unitPrice: text("unit_price"), // Unit price if available
  totalPrice: text("total_price"), // Total price for this dealer-product combination
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPurchaseOrderItemSchema = createInsertSchema(purchaseOrderItems).pick({
  purchaseOrderId: true,
  dealerName: true,
  vehicleNumber: true,
  driverName: true,
  productId: true,
  productCode: true,
  productName: true,
  barcode: true,
  quantity: true,
  unitPrice: true,
  totalPrice: true,
  notes: true,
});

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type InsertPurchaseOrder = z.infer<typeof insertPurchaseOrderSchema>;

export type PurchaseOrderItem = typeof purchaseOrderItems.$inferSelect;
export type InsertPurchaseOrderItem = z.infer<typeof insertPurchaseOrderItemSchema>;

// Aliases for dealer purchase orders (used by frontend)
export type DealerPurchaseOrder = PurchaseOrder;
export type InsertDealerPurchaseOrder = InsertPurchaseOrder;
export type DealerPurchaseOrderItem = PurchaseOrderItem;
export type InsertDealerPurchaseOrderItem = InsertPurchaseOrderItem;

// Data Backup schema
export const backupSettings = pgTable("backup_settings", {
  id: serial("id").primaryKey(),
  lastBackupDate: timestamp("last_backup_date").defaultNow(),
  autoBackupEnabled: boolean("auto_backup_enabled").default(true),
  backupFrequencyHours: integer("backup_frequency_hours").default(24), // Default to daily backups
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertBackupSettingsSchema = createInsertSchema(backupSettings).pick({
  lastBackupDate: true,
  autoBackupEnabled: true,
  backupFrequencyHours: true,
});

// Backup tables for historical data
export const scanHistoryBackup = pgTable("scan_history_backup", {
  id: serial("id").primaryKey(),
  originalId: integer("original_id"), // Reference to the original record ID
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
  backupDate: timestamp("backup_date").defaultNow(), // When the record was backed up
});



// Proforma Slip backup schema
export const proformaSlipsBackup = pgTable("proforma_slips_backup", {
  id: serial("id").primaryKey(),
  originalId: integer("original_id"), // Reference to the original record ID
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
  backupDate: timestamp("backup_date").defaultNow(), // When the record was backed up
});

// Proforma Slip Items backup schema
export const proformaSlipItemsBackup = pgTable("proforma_slip_items_backup", {
  id: serial("id").primaryKey(),
  originalId: integer("original_id"), // Reference to the original record ID
  proformaSlipId: integer("proforma_slip_id"), // Reference to the original proforma slip ID
  proformaSlipBackupId: integer("proforma_slip_backup_id"), // Reference to the backup proforma slip ID
  productId: integer("product_id"),
  quantity: integer("quantity"),
  srNo: text("sr_no"),
  barcode: text("barcode"),
  itemName: text("item_name"),
  createdAt: timestamp("created_at"),
  backupDate: timestamp("backup_date").defaultNow(), // When the record was backed up
});

export type BackupSettings = typeof backupSettings.$inferSelect;
export type InsertBackupSettings = z.infer<typeof insertBackupSettingsSchema>;

// Loading Operations Items backup schema
export const loadingOpItemsBackup = pgTable("load_operations_items_backup", {
  id: serial("id").primaryKey(),
  originalId: integer("original_id"), // Reference to the original record ID
  loadOperationsId: integer("load_operations_id"), // Reference to the original operation ID
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
  backupDate: timestamp("backup_date").defaultNow(), // When the record was backed up
});

// Loading Operations backup schema
export const loadingOperationsBackup = pgTable("load_operations_backup", {
  id: serial("id").primaryKey(),
  originalId: integer("original_id"), // Reference to the original record ID
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
  backupDate: timestamp("backup_date").defaultNow(), // When the record was backed up
});

export type ScanHistoryBackup = typeof scanHistoryBackup.$inferSelect;
export type LoadingOpItemBackup = typeof loadingOpItemsBackup.$inferSelect;
export type LoadingOperationBackup = typeof loadingOperationsBackup.$inferSelect;

export type ProformaSlipBackup = typeof proformaSlipsBackup.$inferSelect;
export type ProformaSlipItemBackup = typeof proformaSlipItemsBackup.$inferSelect;

// Messages schema
export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  senderCode: text("sender_code").notNull(), // Uses userCode instead of user ID
  recipientCode: text("recipient_code"), // Optional for broadcast messages, uses userCode
  content: text("content").notNull(),
  isRead: boolean("is_read").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  broadcastToAll: boolean("broadcast_to_all").default(false),
  broadcastToDesignation: text("broadcast_to_designation"), // For sending to specific designations
  broadcastToDepartment: text("broadcast_to_department"), // For sending to specific departments
});

export const insertMessageSchema = createInsertSchema(messages).pick({
  senderCode: true,
  recipientCode: true,
  content: true,
  isRead: true,
  broadcastToAll: true,
  broadcastToDesignation: true,
  broadcastToDepartment: true,
});

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

// Session table for express-session PostgreSQL store
export const session = pgTable("session", {
  sid: text("sid").primaryKey(),
  sess: text("sess").notNull(), // JSON session data
  expire: timestamp("expire").notNull(),
});

export type Activity = typeof activities.$inferSelect;
export type InsertActivity = z.infer<typeof insertActivitySchema>;



// Orders schema
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  orderNumber: text("order_number").notNull(),
  dealer: text("dealer").notNull(),
  plant: text("plant"),
  vehicleNumber: text("vehicle_number"),
  orderDate: text("order_date").default(new Date().toISOString().split('T')[0]),
  status: text("status").default("DRAFT"),
  createdByCode: text("created_by_code").references(() => users.userCode),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  notes: text("notes"),
  sentToProforma: boolean("sent_to_proforma").default(false),
  proformaId: integer("proforma_id"),
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  sentToProforma: true,
  proformaId: true
});

export type Order = typeof orders.$inferSelect;
export type InsertOrder = z.infer<typeof insertOrderSchema>;

// Order Items schema
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
  updatedAt: timestamp("updated_at").defaultNow()
});

export const insertOrderItemSchema = createInsertSchema(orderItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

// In schema.ts
export const plants = pgTable("plants", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  bgColor: text("bg_color").notNull(),
  textColor: text("text_color").notNull(),
  borderColor: text("border_color").notNull(),
  isLockingEnabled: boolean("is_locking_enabled").default(true),
  isSplitPagesEnabled: boolean("is_split_pages_enabled").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPlantSchema = createInsertSchema(plants).pick({
  name: true,
  bgColor: true,
  textColor: true,
  borderColor: true,
  isLockingEnabled: true,
  isSplitPagesEnabled: true,
});

export type Plant = typeof plants.$inferSelect;
export type InsertPlant = typeof plants.$inferInsert;

export type OrderItem = typeof orderItems.$inferSelect;
export type InsertOrderItem = z.infer<typeof insertOrderItemSchema>;