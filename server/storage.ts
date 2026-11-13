import { 
  users, type User, type InsertUser,
  products, type Product, type InsertProduct,
  purchases, type Purchase, type InsertPurchase,
  purchaseOrders, type PurchaseOrder, type InsertPurchaseOrder,
  purchaseOrderItems, type PurchaseOrderItem, type InsertPurchaseOrderItem,
  type DealerPurchaseOrder, type InsertDealerPurchaseOrder,
  type DealerPurchaseOrderItem, type InsertDealerPurchaseOrderItem,
  proformaSlips, type ProformaSlip, type InsertProformaSlip,
  proformaSlipItems, type ProformaSlipItem, type InsertProformaSlipItem,
  orders, type Order, type InsertOrder,
  messages, type Message, type InsertMessage,
  activities, type Activity, type InsertActivity,
  plants, type Plant, type InsertPlant,
  plantStvs, type PlantStv, type InsertPlantStv,
  vehicleInfo, type VehicleInfo, type InsertVehicleInfo,
  loadingRecords, type LoadingRecord, type InsertLoadingRecord
} from "@shared/schema";
import { and, gte, lte, lt, eq, asc, desc, sql, like, ilike, or, isNull, isNotNull, inArray, not } from "drizzle-orm";
import nodePersist from 'node-persist';
import { db } from "./db";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { pool } from "./db";

export interface NotionProductsQuery {
  page: number;
  pageSize: number;
  search?: string;
  category?: string;
  brand?: string;
  plant?: string;
  type?: string;
  saleCategory?: string;
  linkedOnly?: boolean;
}

export interface IStorage {
  // Session store for authentication
  sessionStore: session.Store;
  
  getAllPlants(): Promise<Plant[]>;
  getPlantByName(name: string): Promise<Plant | undefined>;
  createPlant(plant: InsertPlant): Promise<Plant>;
  updatePlant(id: number, plant: Partial<InsertPlant>): Promise<Plant | undefined>;
  deletePlant(id: number): Promise<boolean>;
  listPlantStvs(plantId: number): Promise<PlantStv[]>;
  createPlantStv(stv: InsertPlantStv): Promise<PlantStv>;
  updatePlantStv(id: number, stv: Partial<InsertPlantStv>): Promise<PlantStv | undefined>;
  deletePlantStv(id: number): Promise<boolean>;

  // User operations
  getUser(userCode: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByUserCode(userCode: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(userCode: string, user: Partial<InsertUser>): Promise<User | undefined>;
  updateUserPin(userCode: string, pin: string): Promise<User | undefined>;
  deleteUser(userCode: string): Promise<boolean>;
  listUsers(limit?: number, offset?: number): Promise<User[]>;
  getAllUsers(): Promise<User[]>; // Get all users without pagination

  // Product operations
  getProduct(id: number): Promise<Product | undefined>;
  // plant is optional — only used to disambiguate when the same barcode exists under more than
  // one Product Master row (see DBStorage's own implementation comment for why that happens).
  getProductByBarcode(barcode: string, plant?: string | null): Promise<Product | undefined>;
  getProductByName(name: string): Promise<Product | undefined>;
  getProductsByIds(ids: number[]): Promise<Product[]>; // Batch get products by IDs
  createProduct(product: InsertProduct): Promise<Product>;
  updateProduct(id: number, product: Partial<InsertProduct>): Promise<Product | undefined>;
  deleteProduct(id: number): Promise<boolean>;
  listProducts(limit?: number, offset?: number): Promise<Product[]>;
  getAllProducts(): Promise<Product[]>; // Get all products without pagination
  getNotionProductsPage(params: NotionProductsQuery): Promise<{ products: Product[]; total: number }>;
  getNotionProductFilterOptions(): Promise<{ categories: string[]; brands: string[]; plants: string[]; types: string[]; saleCategories: string[] }>;
  clearInventory(): Promise<void>; // Method to clear all inventory data
  resetInventoryStock(): Promise<number>; // Method to reset all inStock values to zero

  // Purchase operations
  createPurchase(purchase: InsertPurchase): Promise<Purchase>;
  getPurchase(id: number): Promise<Purchase | undefined>;
  updatePurchase(id: number, purchase: Partial<InsertPurchase>): Promise<Purchase | undefined>;
  deletePurchase(id: number): Promise<boolean>;
  listPurchases(limit?: number, offset?: number): Promise<Purchase[]>;


  // Proforma Slip operations
  createProformaSlip(slip: InsertProformaSlip): Promise<ProformaSlip>;
  getProformaSlip(id: number): Promise<ProformaSlip | undefined>;
  getProformaSlipByOrderNumber(orderNumber: string): Promise<ProformaSlip | undefined>;
  getProformaSlipsByOrderNumbers(orderNumbers: string[]): Promise<ProformaSlip[]>;
  updateProformaSlip(id: number, slip: Partial<InsertProformaSlip>): Promise<ProformaSlip | undefined>;
  deleteProformaSlip(id: number): Promise<boolean>;
  listProformaSlips(limit?: number, offset?: number): Promise<ProformaSlip[]>;

  // Proforma Slip Item operations
  createProformaSlipItem(item: InsertProformaSlipItem): Promise<ProformaSlipItem>;
  getProformaSlipItems(proformaSlipId: number): Promise<ProformaSlipItem[]>;
  getProformaSlipItemsByIds(itemIds: number[]): Promise<ProformaSlipItem[]>;
  getProformaSlipItem(id: number): Promise<ProformaSlipItem | undefined>;
  updateProformaSlipItem(id: number, item: Partial<InsertProformaSlipItem>): Promise<ProformaSlipItem | undefined>;
  deleteProformaSlipItem(id: number): Promise<boolean>;
  // Clears every item on a slip (by the SLIP's id, not one item's id) without touching the slip
  // itself — used when re-importing an existing order to wipe and recreate its items. Previously
  // only existed inlined inside deleteProformaSlip (which also deletes the slip); factored out
  // since proforma-api.ts's Notion re-import needed this half on its own.
  deleteProformaSlipItemsBySlipId(proformaSlipId: number): Promise<void>;

  // Run a backup operation to move all non-backed up records to backup tables
  runBackupOperation(): Promise<{
    scansBackedUp: number,
    proformaSlipsBackedUp: number
  }>;

  // Message operations
  createMessage(message: InsertMessage): Promise<Message>;
  getMessage(id: number): Promise<Message | undefined>;
  deleteMessage(id: number): Promise<boolean>;
  listMessages(limit?: number, offset?: number): Promise<Message[]>;

  // Get messages for a specific user (as recipient or from broadcasts)
  getMessagesForUser(userCode: string, limit?: number, offset?: number): Promise<Message[]>;

  // Get conversations between users
  getConversation(user1Code: string, user2Code: string, limit?: number, offset?: number): Promise<Message[]>;

  // Mark message as read
  markMessageAsRead(id: number): Promise<Message | undefined>;

  // Get unread message count for a user
  getUnreadMessageCount(userCode: string): Promise<number>;

  // Activity tracking operations
  createActivity(activity: InsertActivity): Promise<Activity>;
  logActivity(activity: {
    pageName: string;
    action: string;
    entityType: string;
    entityId: string | number;
    details: string | object;
    userCode?: string;
    userName?: string;
  }): Promise<Activity>;
  getActivity(id: number): Promise<Activity | undefined>;
  deleteActivity(id: number): Promise<boolean>;
  listActivities(limit?: number, offset?: number): Promise<Activity[]>;
  getActivitiesByPage(pageName: string, limit?: number, offset?: number): Promise<Activity[]>;
  getActivitiesByAction(action: string, limit?: number, offset?: number): Promise<Activity[]>;
  getEntityActivities(entityType: string, entityId: string, limit?: number): Promise<Activity[]>;
  // Delete test activities (pageName="Test")
  deleteTestActivities(): Promise<number>;

  // Vehicle Info operations
  createVehicleInfo(vehicle: InsertVehicleInfo): Promise<VehicleInfo>;
  getVehicleInfo(id: number): Promise<VehicleInfo | undefined>;
  getVehicleInfoByVehicleNumber(vehicleNumber: string): Promise<VehicleInfo | undefined>;
  getVehicleInfoByVehicleNumberOrRto(value: string): Promise<VehicleInfo | undefined>;
  getVehicleInfoFromNotionText(raw: string): Promise<VehicleInfo | undefined>;
  updateVehicleInfo(id: number, vehicle: Partial<InsertVehicleInfo>): Promise<VehicleInfo | undefined>;
  deleteVehicleInfo(id: number): Promise<boolean>;
  listVehicleInfo(limit?: number, offset?: number): Promise<VehicleInfo[]>;
  getAllVehicleInfo(): Promise<VehicleInfo[]>;
  clearVehicleInfo(): Promise<void>;

  // Loading records — history of vehicle-link actions from the Loading page.
  createLoadingRecord(record: InsertLoadingRecord): Promise<LoadingRecord>;
  // createdByCode: when set, scopes to just that user's own records (non-admin view);
  // omitted returns everything, newest first (admin view).
  listLoadingRecords(createdByCode?: string): Promise<LoadingRecord[]>;
  getPurchaseOrder(id: number): Promise<PurchaseOrder | undefined>;
  deletePurchaseOrder(id: number): Promise<boolean>;
  listPurchaseOrders(limit?: number, offset?: number): Promise<PurchaseOrder[]>;

  // Purchase Order Item operations  
  createPurchaseOrderItem(item: InsertPurchaseOrderItem): Promise<PurchaseOrderItem>;
  getPurchaseOrderItems(purchaseOrderId: number): Promise<PurchaseOrderItem[]>;
  getPurchaseOrderItem(id: number): Promise<PurchaseOrderItem | undefined>;
  deletePurchaseOrderItem(id: number): Promise<boolean>;
  createPurchaseOrderItems(items: InsertPurchaseOrderItem[]): Promise<PurchaseOrderItem[]>;
  
  // Purchase totals calculation (automatic products.purchased field updates)
  recalculateProductPurchased(productId: number): Promise<void>;
  recalculateAllProductsPurchased(): Promise<void>;
  
  updateProductPurchaseTotals(productIds?: number[]): Promise<void>;
  
  getStockDataByDate(date?: Date, category?: string, searchQuery?: string): Promise<Array<{
    id: number;
    itemName: string;
    category?: string | null;
    inStock: number;
    purchased: number;
    sold: number;
    calculatedStock: number; // inStock + purchased - sold
  }>>;
}

// Use the database connection imported at the top of the file

// PostgreSQL database storage implementation
export class DBStorage implements IStorage {
  // Session store for authentication
  public sessionStore: session.Store;

  constructor() {
    console.log('Initializing DBStorage with PostgreSQL database');
    
    // Initialize PostgreSQL session store
    const PostgresSessionStore = connectPg(session);
    
    // Create session store with proper error handling
    this.sessionStore = new PostgresSessionStore({
      pool,
      // Try to create the table if missing for deployment compatibility
      createTableIfMissing: true,
      tableName: 'session',
      // Add error handling for deployment
      // connect-pg-simple calls this as errorLog('some prefix:', err) — a STRING first, the
      // actual Error second (see pruneSessions/pool.on('error') in its own source) — not a
      // single Error argument. Treating the first arg as the Error and reading .message off it
      // crashed the whole process (TypeError: Cannot read properties of undefined) the moment
      // session pruning hit any failure, since a string has no .message property.
      errorLog: (...args: unknown[]) => {
        const err = args.find((a): a is Error => a instanceof Error);
        const message = err?.message ?? '';
        // Only log unexpected errors (not relation already exists)
        if (!message.includes('already exists') && !message.includes('session_pkey')) {
          console.error('Session store error:', ...args);
        }
      }
    });
    
    // Suppress error logging for the session table
    pool.on('error', (err) => {
      // Only log errors that aren't related to the session table
      if (!err.message.includes('session_pkey')) {
        console.error('Postgres pool error:', err);
      }
    });
  }

  // User operations
  async getUser(userCode: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.userCode, userCode)).limit(1);
    return result.length ? result[0] : undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username)).limit(1);
    return result.length ? result[0] : undefined;
  }

  async getUserByUserCode(userCode: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.userCode, userCode)).limit(1);
    return result.length ? result[0] : undefined;
  }

  async createUser(user: InsertUser): Promise<User> {
    try {
      // Check for duplicate PIN if provided
      if (user.pin) {
        const existingUserWithPin = await db.select().from(users).where(eq(users.pin, user.pin)).limit(1);
        if (existingUserWithPin.length > 0) {
          throw new Error(`PIN ${user.pin} is already used by another user. Please choose a different PIN.`);
        }
      }
      
      const result = await db.insert(users).values(user).returning();
      return result[0];
    } catch (error: any) {
      // Check if the error is a primary key violation
      if (error.code === '23505' && error.constraint === 'users_pkey') {
        console.log(`User with userCode ${user.userCode} already exists. Using existing user.`);
        
        // If the user provided an explicit userCode that already exists, try to get that user
        if (user.userCode) {
          const existingUser = await this.getUser(user.userCode);
          if (existingUser) {
            return existingUser;
          }
        }
      }
      
      // Re-throw if it's not a handled error or we couldn't recover
      throw error;
    }
  }

  async updateUser(userCode: string, user: Partial<InsertUser>): Promise<User | undefined> {
    // Check for duplicate PIN if PIN is being updated
    if (user.pin) {
      const existingUserWithPin = await db.select().from(users)
        .where(and(eq(users.pin, user.pin), not(eq(users.userCode, userCode))))
        .limit(1);
      if (existingUserWithPin.length > 0) {
        throw new Error(`PIN ${user.pin} is already used by another user. Please choose a different PIN.`);
      }
    }
    
    const result = await db.update(users).set(user).where(eq(users.userCode, userCode)).returning();
    return result.length ? result[0] : undefined;
  }
  
  async updateUserPin(userCode: string, pin: string): Promise<User | undefined> {
    console.log(`Updating PIN for user code ${userCode}`);
    
    // Check for duplicate PIN
    const existingUserWithPin = await db.select().from(users)
      .where(and(eq(users.pin, pin), not(eq(users.userCode, userCode))))
      .limit(1);
    if (existingUserWithPin.length > 0) {
      const existingUser = existingUserWithPin[0];
      throw new Error(`PIN ${pin} is already used by user "${existingUser.name || existingUser.username}". Please choose a different PIN.`);
    }
    
    const result = await db.update(users).set({ pin }).where(eq(users.userCode, userCode)).returning();
    return result.length ? result[0] : undefined;
  }

  async deleteUser(userCode: string): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.userCode, userCode)).returning({ userCode: users.userCode });
    return result.length > 0;
  }

  async listUsers(limit = 100, offset = 0): Promise<User[]> {
    return await db.select().from(users).limit(limit).offset(offset);
  }
  
  async getAllUsers(): Promise<User[]> {
    try {
      // Get all users without pagination
      const allUsers = await db.select().from(users);
      console.log(`Retrieved ${allUsers.length} users from database for PIN validation`);
      return allUsers;
    } catch (error) {
      console.error('Error in getAllUsers:', error);
      return [];
    }
  }

  // Product operations
  async getProduct(id: number): Promise<Product | undefined> {
    const result = await db.select().from(products).where(eq(products.id, id)).limit(1);
    return result.length ? result[0] : undefined;
  }

  // plant is optional and only matters when a barcode is shared by more than one Product Master
  // row (a real, intentional case — the same barcode can mean a different pack/product per
  // plant). Without it, or when there's only one match, this behaves exactly as before. With it,
  // prefer the row whose OWN plant is in the SAME STATE as the plant given — the same state-level
  // resolution already used for pallet size (products.gjPlt/mpPlt) — so scanning at Valsad never
  // silently pulls back Indore's name/SAP code for a barcode both plants happen to share. Falls
  // back to the first match if none share that state, so nothing changes for a single-row barcode.
  async getProductByBarcode(barcode: string, plant?: string | null): Promise<Product | undefined> {
    const matches = await db.select().from(products).where(eq(products.barcode, barcode.trim()));
    if (matches.length <= 1 || !plant) return matches[0];

    // products.plant isn't always a single real plant name — 136 rows use the combined label
    // "VAL & IND" (this data applies to both Valsad AND Indore together), and some rows have no
    // plant at all. Split on any non-letter separator and resolve each piece to a real plant
    // (exact name match, or a prefix match for an abbreviation like "VAL"/"IND") so a combined
    // label resolves to EVERY state it covers, not zero — a plain plants-table lookup on the raw
    // "VAL & IND" string finds nothing and would otherwise always fall through to the wrong row.
    const allPlants = await this.getAllPlants();
    const resolveStates = (label: string | null | undefined): Set<string> => {
      const states = new Set<string>();
      if (!label) return states;
      const tokens = label.split(/[^a-zA-Z]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
      for (const token of tokens) {
        const found = allPlants.find((p) => String(p.name).toUpperCase() === token)
          ?? allPlants.find((p) => String(p.name).toUpperCase().startsWith(token));
        if (found?.state) states.add(String(found.state).trim().toUpperCase());
      }
      return states;
    };

    const targetStates = resolveStates(plant);
    if (targetStates.size === 0) return matches[0];

    for (const candidate of matches) {
      const candidateStates = resolveStates(candidate.plant);
      for (const s of candidateStates) {
        if (targetStates.has(s)) return candidate;
      }
    }
    return matches[0];
  }

  async getProductByName(name: string): Promise<Product | undefined> {
    const result = await db.select().from(products).where(ilike(products.name, name.trim())).limit(1);
    return result.length ? result[0] : undefined;
  }

  async getProductsByIds(ids: number[]): Promise<Product[]> {
    if (!ids || ids.length === 0) return [];
    
    console.log(`Fetching ${ids.length} products by IDs`);
    return await db.select().from(products).where(inArray(products.id, ids));
  }

  async createProduct(product: InsertProduct): Promise<Product> {
    const productData: Record<string, any> = { ...product };

    // Trimmed at the single low-level function every product write passes through (Notion sync,
    // Product Master edits, CSV imports) — product_plant_stock/stock_movements key on the literal
    // barcode string, so an untrimmed value here becomes a permanently different barcode as far
    // as stock is concerned, silently orphaning quantity under a stray-whitespace variant.
    if (typeof productData.barcode === 'string') productData.barcode = productData.barcode.trim();

    for (const key of ["lastUpdated", "createdAt", "updatedAt"]) {
      const value = productData[key];
      if (typeof value === "string") {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) {
          productData[key] = date;
        } else {
          delete productData[key];
        }
      }
    }

    const result = await db.insert(products).values(productData as typeof products.$inferInsert).returning();
    return result[0];
  }

  async updateProduct(id: number, product: Partial<InsertProduct>): Promise<Product | undefined> {
    // Process the update data to ensure proper types for database
    const updateData: Record<string, any> = {};

    // Copy and process all properties except lastUpdated
    for (const [key, value] of Object.entries(product)) {
      if (key !== 'lastUpdated') {
        // Special handling for volumeInCuFt to ensure it's saved properly
        if (key === 'volumeInCuFt') {
          // Make sure it's stored as string, even if empty
          updateData[key] = value === null ? '' : String(value);
        } else if (key === 'barcode' && typeof value === 'string') {
          // Trimmed here, before the change-detection below — see createProduct's comment for
          // why (this is the single low-level function every barcode edit passes through).
          updateData[key] = value.trim();
        } else {
          updateData[key] = value;
        }
      }
    }

    // Handle lastUpdated separately
    if (product.lastUpdated) {
      try {
        if (typeof product.lastUpdated === 'string') {
          // If lastUpdated is a string, convert to Date
          updateData.lastUpdated = new Date(product.lastUpdated);
        } else if (product.lastUpdated instanceof Date) {
          // If it's already a Date, use it directly
          updateData.lastUpdated = product.lastUpdated;
        }
        updateData.updatedAt = new Date();
      } catch (error) {
        console.error("Error converting lastUpdated:", error);
        // Use current date as fallback
        updateData.lastUpdated = new Date();
        updateData.updatedAt = new Date();
      }
    } else {
      // If no lastUpdated provided, use current date
      updateData.updatedAt = new Date();
    }
    // Detect a barcode change BEFORE writing it, so the reconciliation below (which runs after)
    // knows whether it actually needs to do anything — this is the single low-level place every
    // barcode edit passes through (Notion sync, manual Product Master edits, anything else),
    // so hooking in here catches all of them rather than each caller needing to remember to.
    let barcodeChanged = false;
    if (typeof updateData.barcode === 'string') {
      const { rows: beforeRows } = await pool.query(`SELECT barcode FROM products WHERE id = $1`, [id]);
      const oldBarcode = beforeRows[0]?.barcode ?? null;
      barcodeChanged = oldBarcode != null && oldBarcode !== updateData.barcode;
    }

    const result = await db.update(products).set(updateData).where(eq(products.id, id)).returning();

    // The product's stock lines follow it (Stock Overview): new barcode / SAP / name / details, and a line that now has the same plant + barcode + SAP
    // as another is merged into it, never left as a duplicate. Best-effort: a failure here must never fail the product update itself.
    if (result.length) {
      const client = await pool.connect();
      try {
        const { syncProductLines } = await import('./lib/stockV2');
        await client.query('BEGIN');
        await syncProductLines(client, id);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`Failed to update stock lines for product ${id}${barcodeChanged ? ' (barcode changed)' : ''}:`, (err as Error)?.message);
      } finally { client.release(); }
    }

    return result.length ? result[0] : undefined;
  }

  async deleteProduct(id: number): Promise<boolean> {
    const result = await db.delete(products).where(eq(products.id, id)).returning({ id: products.id });
    return result.length > 0;
  }

  async listProducts(limit = 1000, offset = 0): Promise<Product[]> {
    console.log(`Fetching products with limit: ${limit}, offset: ${offset}`);
    const result = await db
      .select()
      .from(products)
      .orderBy(products.newSr)
      .limit(limit)
      .offset(offset);
    console.log(`Found ${result.length} products`);
    return result;
  }
  
  async getAllProducts(): Promise<Product[]> {
    try {
      console.log('Fetching ALL products (no pagination)');
      // Get all products without pagination
      const allProducts = await db
        .select()
        .from(products)
        .orderBy(products.newSr);
      console.log(`Retrieved ${allProducts.length} products from database`);
      return allProducts;
    } catch (error) {
      console.error('Error in getAllProducts:', error);
      return [];
    }
  }

  async getNotionProductsPage(params: NotionProductsQuery): Promise<{ products: Product[]; total: number }> {
    const { page, pageSize, search, category, brand, plant, type, saleCategory, linkedOnly } = params;
    const offset = (page - 1) * pageSize;

    const conditions: any[] = [];
    if (search?.trim()) {
      const q = `%${search.trim()}%`;
      conditions.push(or(
        ilike(products.name, q),
        ilike(products.barcode, q),
        ilike(products.newSr, q),
        ilike(products.notionWiseName, q),
        ilike(products.brand, q),
      ));
    }
    if (category) conditions.push(eq(products.category, category));
    if (brand) conditions.push(eq(products.brand, brand));
    if (plant) conditions.push(eq(products.plant, plant));
    if (type) conditions.push(eq(products.type, type));
    if (saleCategory) conditions.push(eq(products.saleCategory, saleCategory));
    if (linkedOnly) conditions.push(isNotNull(products.notionPageId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countRows] = await Promise.all([
      db.select().from(products).where(where).orderBy(products.newSr).limit(pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(products).where(where),
    ]);

    return { products: rows, total: countRows[0]?.count ?? 0 };
  }

  async getNotionProductFilterOptions(): Promise<{ categories: string[]; brands: string[]; plants: string[]; types: string[]; saleCategories: string[] }> {
    const [cats, brnds, plnts, typs, saleCats] = await Promise.all([
      db.selectDistinct({ v: products.category }).from(products).where(isNotNull(products.category)).orderBy(products.category),
      db.selectDistinct({ v: products.brand }).from(products).where(isNotNull(products.brand)).orderBy(products.brand),
      db.selectDistinct({ v: products.plant }).from(products).where(isNotNull(products.plant)).orderBy(products.plant),
      db.selectDistinct({ v: products.type }).from(products).where(isNotNull(products.type)).orderBy(products.type),
      db.selectDistinct({ v: products.saleCategory }).from(products).where(isNotNull(products.saleCategory)).orderBy(products.saleCategory),
    ]);
    return {
      categories: cats.map(r => r.v!).filter(Boolean),
      brands: brnds.map(r => r.v!).filter(Boolean),
      plants: plnts.map(r => r.v!).filter(Boolean),
      types: typs.map(r => r.v!).filter(Boolean),
      saleCategories: saleCats.map(r => r.v!).filter(Boolean),
    };
  }

  async clearInventory(): Promise<void> {
    try {
      console.log("Clearing inventory — nullifying FK references first...");

      // Nullify product_id FK references in all child tables before deleting products
      await db.execute(sql`UPDATE scan_session_items SET product_id = NULL WHERE product_id IS NOT NULL`);
      await db.execute(sql`UPDATE scan_session_extras SET product_id = NULL WHERE product_id IS NOT NULL`);
      await db.execute(sql`UPDATE scan_session_pallet_scans SET product_id = NULL WHERE product_id IS NOT NULL`);
      await db.execute(sql`UPDATE order_items SET product_id = NULL WHERE product_id IS NOT NULL`);
      await db.execute(sql`UPDATE purchase_order_items SET product_id = NULL WHERE product_id IS NOT NULL`);

      await db.delete(products);
      console.log("All products deleted successfully");
    } catch (error) {
      console.error("Error in clearInventory:", error);
      throw error;
    }
  }

  async resetInventoryStock(): Promise<number> {
    const result = await db.update(products).set({ inStock: 0 }).returning({ id: products.id });
    return result.length;
  }

  // Purchase operations
  async createPurchase(purchase: InsertPurchase): Promise<Purchase> {
    const result = await db.insert(purchases).values(purchase as typeof purchases.$inferInsert).returning();
    return result[0];
  }

  async getPurchase(id: number): Promise<Purchase | undefined> {
    const result = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
    return result.length ? result[0] : undefined;
  }

  async updatePurchase(id: number, purchase: Partial<InsertPurchase>): Promise<Purchase | undefined> {
    const result = await db.update(purchases).set(purchase as Partial<typeof purchases.$inferInsert>).where(eq(purchases.id, id)).returning();
    return result.length ? result[0] : undefined;
  }

  async deletePurchase(id: number): Promise<boolean> {
    const result = await db.delete(purchases).where(eq(purchases.id, id)).returning({ id: purchases.id });
    return result.length > 0;
  }

  async listPurchases(limit = 100, offset = 0): Promise<Purchase[]> {
    return await db.select().from(purchases).orderBy(desc(purchases.createdAt)).limit(limit).offset(offset);
  }


  // Proforma Slip operations
  async createProformaSlip(slip: InsertProformaSlip): Promise<ProformaSlip> {
    const result = await db.insert(proformaSlips).values(slip as typeof proformaSlips.$inferInsert).returning();
    return result[0];
  }

  async getProformaSlip(id: number): Promise<ProformaSlip | undefined> {
    const result = await db.select().from(proformaSlips).where(eq(proformaSlips.id, id)).limit(1);
    return result.length ? result[0] : undefined;
  }

  async getProformaSlipByOrderNumber(orderNumber: string): Promise<ProformaSlip | undefined> {
    const result = await db.select().from(proformaSlips).where(eq(proformaSlips.orderNumber, orderNumber)).limit(1);
    return result.length ? result[0] : undefined;
  }

  async getProformaSlipsByOrderNumbers(orderNumbers: string[]): Promise<ProformaSlip[]> {
    if (!orderNumbers.length) return [];

    // Use the 'in' operator to fetch multiple slips in a single query
    const result = await db.select()
      .from(proformaSlips)
      .where(inArray(proformaSlips.orderNumber, orderNumbers));

    return result || [];
  }

  async updateProformaSlip(id: number, slip: Partial<InsertProformaSlip>): Promise<ProformaSlip | undefined> {
    const result = await db.update(proformaSlips).set(slip as Partial<typeof proformaSlips.$inferInsert>).where(eq(proformaSlips.id, id)).returning();
    return result.length ? result[0] : undefined;
  }

  async deleteProformaSlip(id: number): Promise<boolean> {
    // First delete all items
    await db.delete(proformaSlipItems).where(eq(proformaSlipItems.proformaSlipId, id));
    // Then delete the slip
    const result = await db.delete(proformaSlips).where(eq(proformaSlips.id, id)).returning({ id: proformaSlips.id });
    return result.length > 0;
  }

  async listProformaSlips(limit = 1000, offset = 0): Promise<ProformaSlip[]> {
    // Check if we're requesting all proforma slips (indicated by a very high limit)
    if (limit > 10000) {
      console.log(`Fetching ALL proforma slips with pagination to avoid DB connection issues`);
      
      try {
        // First get count of total records
        const countResult = await db.select({ count: sql`count(*)` }).from(proformaSlips);
        const totalCount = Number(countResult[0].count);
        console.log(`Total proforma slips count: ${totalCount}`);
        
        // If total count is reasonable, get all at once
        if (totalCount <= 1000) {
          console.log(`Total count ${totalCount} is manageable, fetching all at once`);
          return await db.select().from(proformaSlips).orderBy(desc(proformaSlips.createdAt));
        }
        
        // For larger datasets, use batched fetching with smaller page sizes to avoid connection timeouts
        console.log(`Using batched fetching for ${totalCount} records`);
        const batchSize = 500;
        const batches = Math.ceil(totalCount / batchSize);
        let results: ProformaSlip[] = [];
        
        // Fetch in batches
        for (let i = 0; i < batches; i++) {
          console.log(`Fetching batch ${i+1}/${batches} (offset: ${i * batchSize}, limit: ${batchSize})`);
          const batchResults = await db.select()
            .from(proformaSlips)
            .orderBy(desc(proformaSlips.createdAt))
            .limit(batchSize)
            .offset(i * batchSize);
          
          results = [...results, ...batchResults];
          console.log(`Batch ${i+1} fetched: ${batchResults.length} records`);
        }
        
        console.log(`Total records fetched: ${results.length}`);
        return results;
      } catch (error) {
        console.error(`Error in batched proforma slips fetch:`, error);
        // Fallback to normal pagination with smaller limit
        console.log(`Falling back to standard pagination with limit=${limit > 1000 ? 1000 : limit}`);
        return await db.select()
          .from(proformaSlips)
          .orderBy(desc(proformaSlips.createdAt))
          .limit(limit > 1000 ? 1000 : limit)
          .offset(offset);
      }
    } else {
      // Standard paginated request
      console.log(`Fetching proforma slips with standard pagination (limit=${limit}, offset=${offset})`);
      return await db.select().from(proformaSlips).orderBy(desc(proformaSlips.createdAt)).limit(limit).offset(offset);
    }
  }

  // Proforma Slip Item operations
  async createProformaSlipItem(item: InsertProformaSlipItem): Promise<ProformaSlipItem> {
    const result = await db.insert(proformaSlipItems).values(item).returning();
    return result[0];
  }

  // Batch create multiple items at once for better performance
  async batchCreateProformaSlipItems(items: InsertProformaSlipItem[]): Promise<ProformaSlipItem[]> {
    if (items.length === 0) {
      return [];
    }

    console.log(`Batch creating ${items.length} proforma slip items`);
    const result = await db.insert(proformaSlipItems).values(items).returning();
    return result;
  }

  async getProformaSlipItems(proformaSlipId: number): Promise<ProformaSlipItem[]> {
    return await db.select()
      .from(proformaSlipItems)
      .where(eq(proformaSlipItems.proformaSlipId, proformaSlipId))
      .orderBy(asc(proformaSlipItems.srNo));
  }

  async getProformaSlipItemsByIds(itemIds: number[]): Promise<ProformaSlipItem[]> {
    if (!itemIds || itemIds.length === 0) {
      return [];
    }

    return await db.select()
      .from(proformaSlipItems)
      .where(inArray(proformaSlipItems.id, itemIds))
      .orderBy(asc(proformaSlipItems.srNo));
  }
  
  async getProformaSlipItem(id: number): Promise<ProformaSlipItem | undefined> {
    const items = await db.select()
      .from(proformaSlipItems)
      .where(eq(proformaSlipItems.id, id))
      .limit(1);
    
    return items.length > 0 ? items[0] : undefined;
  }

  async updateProformaSlipItem(id: number, item: Partial<InsertProformaSlipItem>): Promise<ProformaSlipItem | undefined> {
    const result = await db.update(proformaSlipItems).set(item).where(eq(proformaSlipItems.id, id)).returning();
    return result.length ? result[0] : undefined;
  }

  async deleteProformaSlipItem(id: number): Promise<boolean> {
    const result = await db.delete(proformaSlipItems).where(eq(proformaSlipItems.id, id)).returning({ id: proformaSlipItems.id });
    return result.length > 0;
  }

  async deleteProformaSlipItemsBySlipId(proformaSlipId: number): Promise<void> {
    await db.delete(proformaSlipItems).where(eq(proformaSlipItems.proformaSlipId, proformaSlipId));
  }

  // Message operations - using PostgreSQL database
  async createMessage(message: InsertMessage): Promise<Message> {
    const result = await db.insert(messages).values({
      ...message,
      isRead: false
    }).returning();
    return result[0];
  }

  async getMessage(id: number): Promise<Message | undefined> {
    const result = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return result.length ? result[0] : undefined;
  }

  async deleteMessage(id: number): Promise<boolean> {
    const result = await db.delete(messages).where(eq(messages.id, id)).returning();
    return result.length > 0;
  }

  async listMessages(limit = 10, offset = 0): Promise<Message[]> {
    return await db.select().from(messages)
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async getMessagesForUser(userCode: string, limit = 10, offset = 0): Promise<Message[]> {
    // Get user for department/designation checks
    const userQuery = await db.select().from(users).where(eq(users.userCode, userCode)).limit(1);
    const user = userQuery.length ? userQuery[0] : null;

    return await db.select().from(messages)
      .where(
        or(
          eq(messages.recipientCode, userCode),
          eq(messages.broadcastToAll, true),
          and(
            isNotNull(messages.broadcastToDepartment),
            eq(messages.broadcastToDepartment, user?.department || '')
          ),
          and(
            isNotNull(messages.broadcastToDesignation),
            eq(messages.broadcastToDesignation, user?.designation || '')
          )
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async getConversation(user1Code: string, user2Code: string, limit = 20, offset = 0): Promise<Message[]> {
    return await db.select().from(messages)
      .where(
        or(
          and(
            eq(messages.senderCode, user1Code),
            eq(messages.recipientCode, user2Code)
          ),
          and(
            eq(messages.senderCode, user2Code),
            eq(messages.recipientCode, user1Code)
          )
        )
      )
      .orderBy(asc(messages.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async markMessageAsRead(id: number): Promise<Message | undefined> {
    const result = await db.update(messages)
      .set({ isRead: true })
      .where(eq(messages.id, id))
      .returning();
    return result.length ? result[0] : undefined;
  }

  async getUnreadMessageCount(userCode: string): Promise<number> {
    // Get user for department/designation checks
    const user = await db.select().from(users).where(eq(users.userCode, userCode)).limit(1);
    const userData = user.length ? user[0] : null;

    const result = await db.select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(
        and(
          eq(messages.isRead, false),
          or(
            eq(messages.recipientCode, userCode),
            eq(messages.broadcastToAll, true),
            and(
              isNotNull(messages.broadcastToDepartment),
              eq(messages.broadcastToDepartment, userData?.department || '')
            ),
            and(
              isNotNull(messages.broadcastToDesignation),
              eq(messages.broadcastToDesignation, userData?.designation || '')
            )
          )
        )
      );
    
    return result[0]?.count || 0;
  }

  async runBackupOperation(): Promise<{
    scansBackedUp: number,
    loadingOpsBackedUp: number,
    proformaSlipsBackedUp: number
  }> {
    return {
      scansBackedUp: 0,
      loadingOpsBackedUp: 0,
      proformaSlipsBackedUp: 0
    };
  }

  // Method to reset only the sold counts to zero
  async resetSoldCounts(): Promise<number> {
    let updatedCount = 0;

    // Get all products
    const allProducts = await db.select().from(products);

    // Update each product's sold count to 0
    for (const product of allProducts) {
      await db.update(products)
        .set({ sold: 0, lastUpdated: new Date() })
        .where(eq(products.id, product.id));
      updatedCount++;
    }

    console.log(`Reset sold counts to zero for ${updatedCount} products`);
    return updatedCount;
  }


  // Activity tracking operations
  async createActivity(activity: InsertActivity): Promise<Activity> {
    return await db.insert(activities).values(activity).returning().then(res => res[0]);
  }

  async logActivity(activity: {
    pageName: string;
    action: string;
    entityType: string;
    entityId: string | number;
    details: string | object;
    userCode?: string;
    userName?: string;
  }): Promise<Activity> {
    // Format details if it's an object
    const detailsStr = typeof activity.details === 'string' 
      ? activity.details 
      : JSON.stringify(activity.details);
    
    // Convert entityId to string if it's a number
    const entityIdStr = typeof activity.entityId === 'number' 
      ? activity.entityId.toString() 
      : activity.entityId;
    
    // Create activity entry
    return await this.createActivity({
      pageName: activity.pageName,
      action: activity.action,
      entityType: activity.entityType,
      entityId: entityIdStr,
      details: detailsStr,
      userCode: activity.userCode,
      userName: activity.userName
    });
  }

  async getActivity(id: number): Promise<Activity | undefined> {
    return await db.select().from(activities).where(eq(activities.id, id)).then(res => res[0]);
  }

  async deleteActivity(id: number): Promise<boolean> {
    return await db.delete(activities).where(eq(activities.id, id)).then(() => true);
  }

  async listActivities(limit: number = 100, offset: number = 0): Promise<Activity[]> {
    return await db.select().from(activities).orderBy(desc(activities.createdAt)).limit(limit).offset(offset);
  }

  async getActivitiesByPage(pageName: string, limit: number = 100, offset: number = 0): Promise<Activity[]> {
    return await db.select().from(activities)
      .where(eq(activities.pageName, pageName))
      .orderBy(desc(activities.createdAt))
      .limit(limit).offset(offset);
  }

  async getActivitiesByAction(action: string, limit: number = 100, offset: number = 0): Promise<Activity[]> {
    return await db.select().from(activities)
      .where(eq(activities.action, action))
      .orderBy(desc(activities.createdAt))
      .limit(limit).offset(offset);
  }

  async getEntityActivities(entityType: string, entityId: string, limit: number = 100): Promise<Activity[]> {
    return await db.select().from(activities)
      .where(and(
        eq(activities.entityType, entityType),
        eq(activities.entityId, entityId)
      ))
      .orderBy(desc(activities.createdAt))
      .limit(limit);
  }

  // Delete test activities
  async deleteTestActivities(): Promise<number> {
    // Delete activities with pageName='Test' or action='test'
    const result = await db.delete(activities)
      .where(or(
        eq(activities.pageName, 'Test'),
        eq(activities.action, 'test')
      ))
      .returning();

    console.log(`Deleted ${result.length} test activities`);
    return result.length;
  }

  // Vehicle Info operations
  async createVehicleInfo(vehicle: InsertVehicleInfo): Promise<VehicleInfo> {
    try {
      const now = new Date();
      // Set the creation and last edited timestamps
      const vehicleData = {
        ...vehicle,
        lastEditedAt: now,
        createdAt: now
      };

      const [result] = await db.insert(vehicleInfo).values(vehicleData).returning();
      return result;
    } catch (error) {
      console.error("Error creating vehicle info:", error);
      throw error;
    }
  }

  async getVehicleInfo(id: number): Promise<VehicleInfo | undefined> {
    try {
      const [result] = await db.select().from(vehicleInfo).where(eq(vehicleInfo.id, id)).limit(1);
      return result;
    } catch (error) {
      console.error("Error getting vehicle info:", error);
      return undefined;
    }
  }

  async getVehicleInfoByVehicleNumber(vehicleNumber: string): Promise<VehicleInfo | undefined> {
    try {
      const [result] = await db.select().from(vehicleInfo).where(eq(vehicleInfo.vehicleNumber, vehicleNumber)).limit(1);
      return result;
    } catch (error) {
      console.error("Error getting vehicle info by vehicle number:", error);
      return undefined;
    }
  }

  // Notion's dispatch DB "Vehi No:" rollup isn't reliably formatted — depending on how that row
  // was filled in, the sync (see extractVehicleCode in proformaNotionSync.ts) can end up storing
  // the bare vehicle code ("112"), the RTO plate number alone ("GJ-15-AV-8225"), or occasionally
  // something else, onto proforma_slips.vehicleNumber — not always the vehicle_number value a
  // plain getVehicleInfoByVehicleNumber lookup expects. This tries both columns, case-
  // insensitively, so Loading's vehicle-confirm step still finds the right Vehicle Master row
  // whichever piece Notion happened to write.
  async getVehicleInfoByVehicleNumberOrRto(value: string): Promise<VehicleInfo | undefined> {
    try {
      const [result] = await db.select().from(vehicleInfo)
        .where(or(ilike(vehicleInfo.vehicleNumber, value), ilike(vehicleInfo.rtoNumber, value)))
        .limit(1);
      return result;
    } catch (error) {
      console.error("Error getting vehicle info by vehicle number or RTO:", error);
      return undefined;
    }
  }

  // Resolves Notion's raw "Vehi No:" text (e.g. "112 {GJ-15-AV-8225}", or occasionally just the
  // bare code or just the RTO plate alone) down to the ONE specific Vehicle Master row it means,
  // so an order can be linked by that row's stable id instead of by this text — the id survives
  // even if the vehicle's own number/RTO text is later edited in Vehicle Master, whereas a fresh
  // text match could silently land on a different (or no) row after such an edit. When the text
  // has both pieces, requires them to match the SAME row (higher confidence than either alone);
  // falls back to matching either column alone when only one piece is present, or the combined
  // match found nothing.
  async getVehicleInfoFromNotionText(raw: string): Promise<VehicleInfo | undefined> {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const idx = trimmed.indexOf(' {');
    if (idx >= 0) {
      const code = trimmed.slice(0, idx).trim();
      const rto = trimmed.slice(idx + 2).replace(/\}\s*$/, '').trim();
      if (code && rto) {
        try {
          const [combined] = await db.select().from(vehicleInfo)
            .where(and(ilike(vehicleInfo.vehicleNumber, code), ilike(vehicleInfo.rtoNumber, rto)))
            .limit(1);
          if (combined) return combined;
        } catch (error) {
          console.error("Error getting vehicle info by combined vehicle number + RTO:", error);
        }
      }
      return this.getVehicleInfoByVehicleNumberOrRto(code || trimmed);
    }
    return this.getVehicleInfoByVehicleNumberOrRto(trimmed);
  }

  async updateVehicleInfo(id: number, vehicle: Partial<InsertVehicleInfo>): Promise<VehicleInfo | undefined> {
    try {
      // Update the last edited timestamp
      const updatedVehicle = {
        ...vehicle,
        lastEditedAt: new Date(),
      };

      const [result] = await db.update(vehicleInfo)
        .set(updatedVehicle)
        .where(eq(vehicleInfo.id, id))
        .returning();

      return result;
    } catch (error) {
      console.error("Error updating vehicle info:", error);
      return undefined;
    }
  }

  async deleteVehicleInfo(id: number): Promise<boolean> {
    try {
      await db.delete(vehicleInfo).where(eq(vehicleInfo.id, id));
      return true;
    } catch (error) {
      console.error("Error deleting vehicle info:", error);
      return false;
    }
  }

  async listVehicleInfo(limit = 100, offset = 0): Promise<VehicleInfo[]> {
    try {
      const results = await db.select()
        .from(vehicleInfo)
        .orderBy(asc(vehicleInfo.srNo))
        .limit(limit)
        .offset(offset);

      return results;
    } catch (error) {
      console.error("Error listing vehicle info:", error);
      return [];
    }
  }

  // Unpaginated — for Notion sync's own byNotionPageId comparison, not the page's own list view.
  async getAllVehicleInfo(): Promise<VehicleInfo[]> {
    try {
      return await db.select().from(vehicleInfo).orderBy(asc(vehicleInfo.srNo));
    } catch (error) {
      console.error("Error in getAllVehicleInfo:", error);
      return [];
    }
  }

  async clearVehicleInfo(): Promise<void> {
    try {
      await db.delete(vehicleInfo);
      console.log("All vehicle info deleted successfully");
    } catch (error) {
      console.error("Error in clearVehicleInfo:", error);
      throw error;
    }
  }

  async createLoadingRecord(record: InsertLoadingRecord): Promise<LoadingRecord> {
    const [result] = await db.insert(loadingRecords).values(record).returning();
    return result;
  }

  async listLoadingRecords(createdByCode?: string): Promise<LoadingRecord[]> {
    const query = db.select().from(loadingRecords).orderBy(desc(loadingRecords.createdAt));
    if (createdByCode) return query.where(eq(loadingRecords.createdByCode, createdByCode));
    return query;
  }

  async getStockDataByDate(date?: Date, category?: string, searchQuery?: string): Promise<Array<{
    id: number;
    itemName: string;
    srNo?: string | null;
    category?: string | null;
    inStock: number;
    purchased: number;
    sold: number;
    calculatedStock: number;
  }>> {
    try {
      // Get all products first
      let productQuery = db.select({
        id: products.id,
        itemName: products.name,
        srNo: products.newSr,
        category: products.category,
        inStock: products.inStock,
        purchased: products.purchased,
      }).from(products).$dynamic();

      const productConditions = [];
      
      // Always exclude ZCLOSED and XNEW PROD categories
      productConditions.push(not(eq(products.category, 'ZCLOSED')));
      productConditions.push(not(eq(products.category, 'XNEW PROD')));

      // Apply category filter on products
      if (category) {
        productConditions.push(eq(products.category, category));
      }

      // Apply search query filter on product name
      if (searchQuery) {
        productConditions.push(like(products.name, `%${searchQuery}%`));
      }

      // Combine conditions with AND for products
      if (productConditions.length > 0) {
        productQuery = productQuery.where(and(...productConditions));
      }

      const productResults = await productQuery.orderBy(asc(products.newSr));

      // For each product, calculate sold quantities from proforma slips and purchased quantities from dealer purchase orders
      const resultsWithSales = await Promise.all(
        productResults.map(async (product) => {
          let soldQuantity = 0;
          let purchasedQuantity = 0;

          try {
            // Build where conditions for sales query
            let whereConditions = [eq(proformaSlipItems.srNo, product.srNo ?? "")];
            
            // Apply date filter if provided for sales
            if (date) {
              const dateStr = date.toISOString().split('T')[0]; // Convert to YYYY-MM-DD
              whereConditions.push(eq(proformaSlips.orderDate, dateStr));
            }

            // Build query to get sold quantities from proforma slips - match by sr_no
            const salesQuery = db.select({
              quantity: sql<number>`COALESCE(SUM(${proformaSlipItems.quantity}), 0)::int`
            })
            .from(proformaSlipItems)
            .leftJoin(proformaSlips, eq(proformaSlipItems.proformaSlipId, proformaSlips.id))
            .where(and(...whereConditions));

            const salesResult = await salesQuery;
            soldQuantity = salesResult[0]?.quantity || 0;
          } catch (error) {
            console.error(`Error calculating sold quantity for product ${product.srNo}:`, error);
            soldQuantity = 0;
          }

          try {
            // Calculate purchased quantities from dealer purchase orders filtered by date
            let purchaseConditions = [eq(purchaseOrderItems.productId, product.id)];
            
            // Apply date filter if provided for purchases - filter by deliveryDate
            if (date) {
              const dateStr = date.toISOString().split('T')[0]; // Convert to YYYY-MM-DD
              purchaseConditions.push(eq(purchaseOrders.deliveryDate, dateStr));
            }

            // Build query to get purchased quantities from dealer purchase orders filtered by deliveryDate
            const purchaseQuery = db.select({
              quantity: sql<number>`COALESCE(SUM(${purchaseOrderItems.quantity}), 0)::int`
            })
            .from(purchaseOrderItems)
            .leftJoin(purchaseOrders, eq(purchaseOrderItems.purchaseOrderId, purchaseOrders.id))
            .where(and(...purchaseConditions));

            const purchaseResult = await purchaseQuery;
            purchasedQuantity = purchaseResult[0]?.quantity || 0;
          } catch (error) {
            console.error(`Error calculating purchased quantity for product ${product.id}:`, error);
            purchasedQuantity = 0;
          }

          const inStock = product.inStock || 0;
          const calculatedStock = inStock + purchasedQuantity - soldQuantity;

          return {
            id: product.id,
            itemName: product.itemName,
            srNo: product.srNo,
            category: product.category,
            inStock,
            purchased: purchasedQuantity,
            sold: soldQuantity,
            calculatedStock,
          };
        })
      );

      return resultsWithSales;
    } catch (error) {
      console.error("Error getting stock data by date:", error);
      return [];
    }
  }

  async getPurchaseOrder(id: number): Promise<PurchaseOrder | undefined> {
    try {
      const [result] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
      return result;
    } catch (error) {
      console.error("Error getting purchase order:", error);
      return undefined;
    }
  }

  async deletePurchaseOrder(id: number): Promise<boolean> {
    try {
      // First delete all items for this purchase order
      await db.delete(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, id));
      // Then delete the purchase order itself
      const result = await db.delete(purchaseOrders).where(eq(purchaseOrders.id, id));
      
      // Recalculate purchased quantities for all affected products
      await this.recalculateAllProductsPurchased();
      
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      console.error("Error deleting purchase order:", error);
      return false;
    }
  }

  async listPurchaseOrders(limit?: number, offset?: number): Promise<PurchaseOrder[]> {
    try {
      let query = db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt)).$dynamic();
      
      if (limit) {
        query = query.limit(limit);
      }
      if (offset) {
        query = query.offset(offset);
      }
      
      return await query;
    } catch (error) {
      console.error("Error listing purchase orders:", error);
      return [];
    }
  }

  // Purchase Order Item operations
  async createPurchaseOrderItem(item: InsertPurchaseOrderItem): Promise<PurchaseOrderItem> {
    try {
      const [result] = await db.insert(purchaseOrderItems).values(item).returning();
      
      // Recalculate purchased quantity for the affected product
      if (result.productId) {
        await this.recalculateProductPurchased(result.productId);
      }
      
      return result;
    } catch (error) {
      console.error("Error creating purchase order item:", error);
      throw error;
    }
  }

  async getPurchaseOrderItems(purchaseOrderId: number): Promise<PurchaseOrderItem[]> {
    try {
      return await db.select().from(purchaseOrderItems)
        .where(eq(purchaseOrderItems.purchaseOrderId, purchaseOrderId))
        .orderBy(asc(purchaseOrderItems.createdAt));
    } catch (error) {
      console.error("Error getting purchase order items:", error);
      return [];
    }
  }

  async getPurchaseOrderItem(id: number): Promise<PurchaseOrderItem | undefined> {
    try {
      const [result] = await db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.id, id));
      return result;
    } catch (error) {
      console.error("Error getting purchase order item:", error);
      return undefined;
    }
  }

  async deletePurchaseOrderItem(id: number): Promise<boolean> {
    try {
      // Get the item first to know which product to recalculate
      const item = await this.getPurchaseOrderItem(id);
      
      const result = await db.delete(purchaseOrderItems).where(eq(purchaseOrderItems.id, id));
      
      // Recalculate purchased quantity for the affected product
      if (item?.productId) {
        await this.recalculateProductPurchased(item.productId);
      }
      
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      console.error("Error deleting purchase order item:", error);
      return false;
    }
  }

  async createPurchaseOrderItems(items: InsertPurchaseOrderItem[]): Promise<PurchaseOrderItem[]> {
    try {
      const results = await db.insert(purchaseOrderItems).values(items).returning();
      
      // Recalculate purchased quantities for all affected products
      const affectedProductIds = [...new Set(results.map(item => item.productId).filter(Boolean))];
      for (const productId of affectedProductIds) {
        await this.recalculateProductPurchased(productId!);
      }
      
      return results;
    } catch (error) {
      console.error("Error creating purchase order items:", error);
      throw error;
    }
  }

  // Purchase totals calculation (automatic products.purchased field updates)
  async recalculateProductPurchased(productId: number): Promise<void> {
    try {
      // Calculate total purchased quantity for this product from all purchase order items
      const [result] = await db.select({
        totalPurchased: sql<number>`COALESCE(SUM(${purchaseOrderItems.quantity}), 0)::int`
      })
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.productId, productId));
      
      const totalPurchased = result?.totalPurchased || 0;
      
      // Update the product's purchased field
      await db.update(products)
        .set({ 
          purchased: totalPurchased,
          updatedAt: new Date()
        })
        .where(eq(products.id, productId));
        
      console.log(`Updated product ${productId} purchased quantity to ${totalPurchased}`);
    } catch (error) {
      console.error(`Error recalculating purchased quantity for product ${productId}:`, error);
    }
  }

  async recalculateAllProductsPurchased(): Promise<void> {
    try {
      // Get all products that have purchase order items
      const productsWithPurchases = await db.select({
        productId: purchaseOrderItems.productId,
        totalPurchased: sql<number>`SUM(${purchaseOrderItems.quantity})::int`
      })
      .from(purchaseOrderItems)
      .where(isNotNull(purchaseOrderItems.productId))
      .groupBy(purchaseOrderItems.productId);
      
      // Update each product's purchased field
      for (const productData of productsWithPurchases) {
        if (productData.productId) {
          await db.update(products)
            .set({ 
              purchased: productData.totalPurchased || 0,
              updatedAt: new Date()
            })
            .where(eq(products.id, productData.productId));
        }
      }
      
      // Reset purchased to 0 for products that have no purchase order items
      await db.update(products)
        .set({ 
          purchased: 0,
          updatedAt: new Date()
        })
        .where(not(inArray(products.id, 
          db.select({ id: purchaseOrderItems.productId })
            .from(purchaseOrderItems)
            .where(isNotNull(purchaseOrderItems.productId))
        )));
      
      console.log(`Recalculated purchased quantities for all products`);
    } catch (error) {
      console.error("Error recalculating all products purchased quantities:", error);
    }
  }

  // Dealer Purchase Order operations (Excel-based consolidated dealer orders)
  async createDealerPurchaseOrder(dealerPurchaseOrder: InsertDealerPurchaseOrder): Promise<DealerPurchaseOrder> {
    try {
      const [result] = await db.insert(purchaseOrders).values(dealerPurchaseOrder as typeof purchaseOrders.$inferInsert).returning();
      return result;
    } catch (error) {
      console.error("Error creating dealer purchase order:", error);
      throw error;
    }
  }

  async getDealerPurchaseOrder(id: number): Promise<DealerPurchaseOrder | undefined> {
    try {
      const [result] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
      return result;
    } catch (error) {
      console.error("Error getting dealer purchase order:", error);
      return undefined;
    }
  }

  async updateDealerPurchaseOrder(id: number, dealerPurchaseOrder: Partial<InsertDealerPurchaseOrder>): Promise<DealerPurchaseOrder | undefined> {
    try {
      const [result] = await db.update(purchaseOrders).set({
        ...dealerPurchaseOrder,
        updatedAt: new Date()
      } as Partial<typeof purchaseOrders.$inferInsert>).where(eq(purchaseOrders.id, id)).returning();
      return result;
    } catch (error) {
      console.error("Error updating dealer purchase order:", error);
      return undefined;
    }
  }

  async deleteDealerPurchaseOrder(id: number): Promise<boolean> {
    try {
      // First delete all items for this dealer purchase order
      await db.delete(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, id));
      // Then delete the dealer purchase order itself
      const result = await db.delete(purchaseOrders).where(eq(purchaseOrders.id, id));
      
      // Recalculate purchased quantities for all affected products
      await this.updateProductPurchaseTotals();
      
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      console.error("Error deleting dealer purchase order:", error);
      return false;
    }
  }

  async listDealerPurchaseOrders(limit = 50, offset = 0, startDate?: Date, endDate?: Date): Promise<DealerPurchaseOrder[]> {
    try {
      let query = db.select().from(purchaseOrders).$dynamic();
      const startDay = startDate ? startDate.toISOString().slice(0, 10) : undefined;
      const endDay = endDate ? endDate.toISOString().slice(0, 10) : undefined;
      
      if (startDate && endDate) {
        query = query.where(and(
          gte(purchaseOrders.orderDate, startDay!),
          lte(purchaseOrders.orderDate, endDay!)
        ));
      } else if (startDate) {
        query = query.where(gte(purchaseOrders.orderDate, startDay!));
      } else if (endDate) {
        query = query.where(lte(purchaseOrders.orderDate, endDay!));
      }
      
      const results = await query
        .orderBy(desc(purchaseOrders.orderDate))
        .limit(limit)
        .offset(offset);
      
      return results;
    } catch (error) {
      console.error("Error listing dealer purchase orders:", error);
      return [];
    }
  }


  // Dealer Purchase Order Items operations (product-dealer-quantity matrix)
  async createDealerPurchaseOrderItem(item: InsertDealerPurchaseOrderItem): Promise<DealerPurchaseOrderItem> {
    try {
      const [result] = await db.insert(purchaseOrderItems).values(item).returning();
      
      // Update product purchased totals
      if (result.productId) {
        await this.updateProductPurchaseTotals([result.productId]);
      }
      
      return result;
    } catch (error) {
      console.error("Error creating dealer purchase order item:", error);
      throw error;
    }
  }

  async getDealerPurchaseOrderItems(purchaseOrderId: number): Promise<DealerPurchaseOrderItem[]> {
    try {
      const results = await db.select().from(purchaseOrderItems)
        .where(eq(purchaseOrderItems.purchaseOrderId, purchaseOrderId))
        .orderBy(asc(purchaseOrderItems.productCode));
      return results;
    } catch (error) {
      console.error("Error getting dealer purchase order items:", error);
      return [];
    }
  }

  async getDealerPurchaseOrderItem(id: number): Promise<DealerPurchaseOrderItem | undefined> {
    try {
      const [result] = await db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.id, id));
      return result;
    } catch (error) {
      console.error("Error getting dealer purchase order item:", error);
      return undefined;
    }
  }

  async updateDealerPurchaseOrderItem(id: number, item: Partial<InsertDealerPurchaseOrderItem>): Promise<DealerPurchaseOrderItem | undefined> {
    try {
      const [result] = await db.update(purchaseOrderItems).set(item).where(eq(purchaseOrderItems.id, id)).returning();
      
      // Update product purchased totals
      if (result?.productId) {
        await this.updateProductPurchaseTotals([result.productId]);
      }
      
      return result;
    } catch (error) {
      console.error("Error updating dealer purchase order item:", error);
      return undefined;
    }
  }

  async deleteDealerPurchaseOrderItem(id: number): Promise<boolean> {
    try {
      // Get the item to know which product to update
      const item = await this.getDealerPurchaseOrderItem(id);
      
      const result = await db.delete(purchaseOrderItems).where(eq(purchaseOrderItems.id, id));
      
      // Update product purchased totals
      if (item?.productId) {
        await this.updateProductPurchaseTotals([item.productId]);
      }
      
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      console.error("Error deleting dealer purchase order item:", error);
      return false;
    }
  }

  async createDealerPurchaseOrderItems(items: InsertDealerPurchaseOrderItem[]): Promise<DealerPurchaseOrderItem[]> {
    try {
      if (items.length === 0) return [];
      const results = await db.insert(purchaseOrderItems).values(items).returning();
      
      // Update product purchased totals for all affected products
      const productIds = results.map(item => item.productId).filter(id => id !== null) as number[];
      if (productIds.length > 0) {
        await this.updateProductPurchaseTotals(productIds);
      }
      
      return results;
    } catch (error) {
      console.error("Error creating dealer purchase order items:", error);
      throw error;
    }
  }

  // Excel import and totals calculation methods
  async createDealerPurchaseOrderFromExcel(excelData: {
    orderDate: Date;
    deliveryDate?: Date;
    dealers: Array<{ name: string; vehicleNumber?: string; driverName?: string }>;
    items: Array<{ 
      productCode: string; 
      productName: string; 
      dealerQuantities: { [dealerName: string]: number } 
    }>;
    notes?: string;
  }): Promise<{
    purchaseOrder: DealerPurchaseOrder;
    items: DealerPurchaseOrderItem[];
  }> {
    try {
      // Create the main purchase order
      const purchaseOrder = await this.createDealerPurchaseOrder({
        orderDate: excelData.orderDate,
        deliveryDate: excelData.deliveryDate,
        status: 'pending',
        totalItems: 0,
        totalDealers: excelData.dealers.length,
        notes: excelData.notes,
        createdByCode: null,
      });

      // Create dealer name mapping (no separate dealers table needed)
      const dealerMap = new Map<string, {vehicleNumber?: string; driverName?: string}>();
      excelData.dealers.forEach(dealer => {
        dealerMap.set(dealer.name, {
          vehicleNumber: dealer.vehicleNumber,
          driverName: dealer.driverName
        });
      });

      // Create items for each dealer-product combination
      const itemsData: InsertDealerPurchaseOrderItem[] = [];
      let totalItems = 0;

      for (const item of excelData.items) {
        // Find product by code
        const product = await db.select().from(products).where(eq(products.itemNo, item.productCode)).limit(1);
        const productId = product[0]?.id || null;

        // Create item for each dealer that has a quantity > 0
        for (const [dealerName, quantity] of Object.entries(item.dealerQuantities)) {
          if (quantity > 0) {
            const dealerInfo = dealerMap.get(dealerName);
            if (dealerInfo) {
              itemsData.push({
                purchaseOrderId: purchaseOrder.id,
                dealerName,
                vehicleNumber: dealerInfo.vehicleNumber,
                driverName: dealerInfo.driverName,
                productId,
                productCode: item.productCode,
                productName: item.productName,
                barcode: product[0]?.barcode,
                quantity
              });
              totalItems += quantity;
            }
          }
        }
      }

      const items = await this.createDealerPurchaseOrderItems(itemsData);

      // Update totals
      await this.recalculateDealerPurchaseOrderTotals(purchaseOrder.id);

      return {
        purchaseOrder,
        items
      };
    } catch (error) {
      console.error("Error creating dealer purchase order from Excel:", error);
      throw error;
    }
  }
  
  async updateProductPurchaseTotals(productIds?: number[]): Promise<void> {
    try {
      if (productIds && productIds.length > 0) {
        // Update specific products
        for (const productId of productIds) {
          // Calculate total from both regular purchase orders and dealer purchase orders
          const regularPurchases = await db.select({
            total: sql<number>`COALESCE(SUM(${purchaseOrderItems.quantity}), 0)::int`
          }).from(purchaseOrderItems).where(eq(purchaseOrderItems.productId, productId));

          const dealerPurchases = await db.select({
            total: sql<number>`COALESCE(SUM(${purchaseOrderItems.quantity}), 0)::int`
          }).from(purchaseOrderItems).where(eq(purchaseOrderItems.productId, productId));

          const totalPurchased = (regularPurchases[0]?.total || 0) + (dealerPurchases[0]?.total || 0);

          await db.update(products)
            .set({ 
              purchased: totalPurchased,
              updatedAt: new Date()
            })
            .where(eq(products.id, productId));
        }
      } else {
        // Update all products
        await this.recalculateAllProductsPurchased();
        
        // Also include dealer purchase order items in the calculation
        const dealerPurchases = await db.select({
          productId: purchaseOrderItems.productId,
          totalPurchased: sql<number>`SUM(${purchaseOrderItems.quantity})::int`
        })
        .from(purchaseOrderItems)
        .where(isNotNull(purchaseOrderItems.productId))
        .groupBy(purchaseOrderItems.productId);

        for (const dealerPurchase of dealerPurchases) {
          if (dealerPurchase.productId) {
            // Get current purchased amount and add dealer purchases
            const [currentProduct] = await db.select({ purchased: products.purchased })
              .from(products)
              .where(eq(products.id, dealerPurchase.productId));
              
            const newTotal = (currentProduct?.purchased || 0) + (dealerPurchase.totalPurchased || 0);
            
            await db.update(products)
              .set({ 
                purchased: newTotal,
                updatedAt: new Date()
              })
              .where(eq(products.id, dealerPurchase.productId));
          }
        }
      }
      
      console.log("Updated product purchase totals");
    } catch (error) {
      console.error("Error updating product purchase totals:", error);
    }
  }
  async getAllPlants(): Promise<Plant[]> {
    return await db.select().from(plants);
  }

  async getPlantByName(name: string): Promise<Plant | undefined> {
    const upperName = String(name).toUpperCase().trim();
    const [plant] = await db
      .select()
      .from(plants)
      .where(eq(plants.name, upperName))
      .limit(1);
    return plant;
  }

  async createPlant(plant: InsertPlant): Promise<Plant> {
    const [newPlant] = await db.insert(plants).values(plant).returning();
    return newPlant;
  }

  async updatePlant(id: number, plant: Partial<InsertPlant>): Promise<Plant | undefined> {
    const [updatedPlant] = await db
      .update(plants)
      .set(plant)
      .where(eq(plants.id, id))
      .returning();
    return updatedPlant;
  }

  async deletePlant(id: number): Promise<boolean> {
    const [deletedPlant] = await db
      .delete(plants)
      .where(eq(plants.id, id))
      .returning();
    return !!deletedPlant;
  }

  async listPlantStvs(plantId: number): Promise<PlantStv[]> {
    return await db
      .select()
      .from(plantStvs)
      .where(eq(plantStvs.plantId, plantId))
      .orderBy(asc(plantStvs.id));
  }

  async createPlantStv(stv: InsertPlantStv): Promise<PlantStv> {
    const [newStv] = await db.insert(plantStvs).values(stv).returning();
    return newStv;
  }

  async updatePlantStv(id: number, stv: Partial<InsertPlantStv>): Promise<PlantStv | undefined> {
    const [updatedStv] = await db
      .update(plantStvs)
      .set(stv)
      .where(eq(plantStvs.id, id))
      .returning();
    return updatedStv;
  }

  async deletePlantStv(id: number): Promise<boolean> {
    const [deletedStv] = await db
      .delete(plantStvs)
      .where(eq(plantStvs.id, id))
      .returning();
    return !!deletedStv;
  }

  async recalculateDealerPurchaseOrderTotals(purchaseOrderId: number): Promise<void> {
    try {
      // Calculate total items and unique dealers for the purchase order
      const [totals] = await db.select({
        totalItems: sql<number>`COALESCE(SUM(${purchaseOrderItems.quantity}), 0)::int`,
        totalDealers: sql<number>`COUNT(DISTINCT ${purchaseOrderItems.dealerName})::int`
      })
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, purchaseOrderId));

      // Update purchase order totals
      await db.update(purchaseOrders)
        .set({
          totalItems: totals?.totalItems || 0,
          totalDealers: totals?.totalDealers || 0,
          updatedAt: new Date()
        })
        .where(eq(purchaseOrders.id, purchaseOrderId));

      console.log(`Recalculated totals for dealer purchase order ${purchaseOrderId}`);
    } catch (error) {
      console.error("Error recalculating dealer purchase order totals:", error);
    }
  }
}

// Initialize the database storage
export const storage = new DBStorage();
