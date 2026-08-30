import { 
  users, type User, type InsertUser,
  products, type Product, type InsertProduct,
  scanHistory, type ScanHistory, type InsertScanHistory,
  loadingOperations, type LoadingOperation, type InsertLoadingOperation,
  loadingOpItems, type LoadingOpItem, type InsertLoadingOpItem,
  purchases, type Purchase, type InsertPurchase,
  purchaseOrders, type PurchaseOrder, type InsertPurchaseOrder,
  purchaseOrderItems, type PurchaseOrderItem, type InsertPurchaseOrderItem,
  type DealerPurchaseOrder, type InsertDealerPurchaseOrder,
  type DealerPurchaseOrderItem, type InsertDealerPurchaseOrderItem,
  proformaSlips, type ProformaSlip, type InsertProformaSlip,
  proformaSlipItems, type ProformaSlipItem, type InsertProformaSlipItem,
  backupSettings, type BackupSettings, type InsertBackupSettings,
  scanHistoryBackup, type ScanHistoryBackup,
  loadingOpItemsBackup, type LoadingOpItemBackup,
  loadingOperationsBackup, type LoadingOperationBackup,
  orders, type Order, type InsertOrder,
  proformaSlipsBackup, type ProformaSlipBackup,
  proformaSlipItemsBackup, type ProformaSlipItemBackup,
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
  getProductByBarcode(barcode: string): Promise<Product | undefined>;
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

  // Scan history operations
  createScanHistory(entry: InsertScanHistory): Promise<ScanHistory>;
  getScanHistory(id: number): Promise<ScanHistory | undefined>;
  deleteScanHistory(id: number): Promise<boolean>;
  listScanHistory(limit?: number, offset?: number): Promise<ScanHistory[]>;

  // Loading operations
  createLoadingOperation(operation: InsertLoadingOperation): Promise<LoadingOperation>;
  getLoadingOperation(id: number): Promise<LoadingOperation | undefined>;
  getLoadingOperationByReferenceNumber(referenceNumber: string): Promise<LoadingOperation | undefined>;
  updateLoadingOperation(id: number, operation: Partial<InsertLoadingOperation>): Promise<LoadingOperation | undefined>;
  deleteLoadingOperation(id: number): Promise<boolean>;
  listLoadingOperations(limit?: number, offset?: number, startDate?: Date, endDate?: Date, orderDate?: Date): Promise<LoadingOperation[]>;
  countLoadingOperationsByStatus(status: string, orderDate?: Date): Promise<number>;
  
  // Loading operation item operations
  getLoadingOperationItems(loadingOperationId: number): Promise<LoadingOpItem[]>;
  getLoadingOperationItem(id: number): Promise<LoadingOpItem | undefined>;
  createLoadingOperationItem(item: InsertLoadingOpItem): Promise<LoadingOpItem>;
  updateLoadingOperationItem(id: number, item: Partial<InsertLoadingOpItem>): Promise<LoadingOpItem | null>;
  deleteLoadingOperationItem(id: number): Promise<boolean>;
  createLoadingOperationItems(items: InsertLoadingOpItem[]): Promise<LoadingOpItem[]>;
  batchUpdateLoadingOperationItems(items: Array<{id: number, data: Partial<InsertLoadingOpItem>}>): Promise<LoadingOpItem[]>;
  
  // For backward compatibility, keep this method but implement it to call getLoadingOperationItems
  getGJOperationItems(loadingOperationId: number): Promise<LoadingOpItem[]>;

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

  // Backup operations
  getBackupSettings(): Promise<BackupSettings | undefined>;
  createBackupSettings(settings: InsertBackupSettings): Promise<BackupSettings>;
  updateBackupSettings(id: number, settings: Partial<InsertBackupSettings>): Promise<BackupSettings | undefined>;

  // Backup retrieval operations for historical data
  backupScanHistory(scanHistoryId: number): Promise<ScanHistoryBackup>;
  backupProformaSlip(proformaSlipId: number): Promise<ProformaSlipBackup>;
  backupProformaSlipItem(slipItemId: number, proformaSlipBackupId: number): Promise<ProformaSlipItemBackup>;

  // List historical data with date filtering
  listScanHistoryBackups(startDate?: Date, endDate?: Date, limit?: number, offset?: number): Promise<ScanHistoryBackup[]>;
  listProformaSlipBackups(startDate?: Date, endDate?: Date, limit?: number, offset?: number): Promise<ProformaSlipBackup[]>;
  listProformaSlipItemBackups(proformaSlipBackupId: number): Promise<ProformaSlipItemBackup[]>;

  // Backup items operations
  deleteProformaSlipBackup(backupId: number): Promise<boolean>;
  deleteProformaSlipBackups(backupIds: number[]): Promise<number>;

  // Run a backup operation to move all non-backed up records to backup tables
  runBackupOperation(): Promise<{
    scansBackedUp: number,
    proformaSlipsBackedUp: number
  }>;

  // Apply data retention policies
  applyDataRetentionPolicies(): Promise<{
    loadingOpsDeleted: number
  }>;

  // Message operations
  createMessage(message: InsertMessage): Promise<Message>;
  getMessage(id: number): Promise<Message | undefined>;
  updateMessage(id: number, message: Partial<InsertMessage>): Promise<Message | undefined>;
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
  // Delete activities older than 30 days
  deleteOldActivities(daysToKeep?: number): Promise<number>;
  // Delete test activities (pageName="Test")
  deleteTestActivities(): Promise<number>;

  // Vehicle Info operations
  createVehicleInfo(vehicle: InsertVehicleInfo): Promise<VehicleInfo>;
  getVehicleInfo(id: number): Promise<VehicleInfo | undefined>;
  getVehicleInfoByVehicleNumber(vehicleNumber: string): Promise<VehicleInfo | undefined>;
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

  // Purchase Order operations
  createPurchaseOrder(purchaseOrder: InsertPurchaseOrder): Promise<PurchaseOrder>;
  getPurchaseOrder(id: number): Promise<PurchaseOrder | undefined>;
  getPurchaseOrderByOrderNumber(orderNumber: string): Promise<PurchaseOrder | undefined>;
  updatePurchaseOrder(id: number, purchaseOrder: Partial<InsertPurchaseOrder>): Promise<PurchaseOrder | undefined>;
  deletePurchaseOrder(id: number): Promise<boolean>;
  listPurchaseOrders(limit?: number, offset?: number): Promise<PurchaseOrder[]>;

  // Purchase Order Item operations  
  createPurchaseOrderItem(item: InsertPurchaseOrderItem): Promise<PurchaseOrderItem>;
  getPurchaseOrderItems(purchaseOrderId: number): Promise<PurchaseOrderItem[]>;
  getPurchaseOrderItem(id: number): Promise<PurchaseOrderItem | undefined>;
  updatePurchaseOrderItem(id: number, item: Partial<InsertPurchaseOrderItem>): Promise<PurchaseOrderItem | undefined>;
  deletePurchaseOrderItem(id: number): Promise<boolean>;
  createPurchaseOrderItems(items: InsertPurchaseOrderItem[]): Promise<PurchaseOrderItem[]>;
  
  // Purchase totals calculation (automatic products.purchased field updates)
  recalculateProductPurchased(productId: number): Promise<void>;
  recalculateAllProductsPurchased(): Promise<void>;

  // Purchase Order Excel import methods (using existing purchase order tables)
  createPurchaseOrderFromExcel(excelData: {
    orderDate: Date;
    deliveryDate?: Date;
    items: Array<{ 
      productCode: string; 
      productName: string; 
      dealerName: string;
      vehicleNumber?: string;
      driverName?: string;
      quantity: number;
    }>;
    notes?: string;
  }): Promise<{
    purchaseOrder: PurchaseOrder;
    items: PurchaseOrderItem[];
  }>;
  
  updateProductPurchaseTotals(productIds?: number[]): Promise<void>;
  recalculatePurchaseOrderTotals(purchaseOrderId: number): Promise<void>;

  // Stock data operations for Stock Sheets
  listProductsForStock(filters?: {
    category?: string;
    searchQuery?: string;
  }): Promise<Array<{
    id: number;
    itemName: string;
    inStock: number;
    purchased: number;
    sold: number;
    category?: string;
  }>>;
  
  getStockDataByDate(date?: Date, category?: string, searchQuery?: string): Promise<Array<{
    id: number;
    itemName: string;
    category?: string;
    inStock: number;
    purchased: number;
    sold: number;
    calculatedStock: number; // inStock + purchased - sold
  }>>;
}

export class MemStorage implements IStorage {
  // Session store for authentication
  public sessionStore: session.Store;
  
  private users: Map<number, User>;
  private products: Map<number, Product>;
  private scans: Map<number, ScanHistory>;
  private loadingOps: Map<number, LoadingOperation>;
  private gjOperationItems: Map<number, LoadingOpItem[]>; // Map loadingOpId to items
  private purchases: Map<number, Purchase>;
  private purchaseOrders: Map<number, PurchaseOrder>;
  private purchaseOrderItems: Map<number, PurchaseOrderItem>;
  private proformaSlips: Map<number, ProformaSlip>;
  private proformaSlipItems: Map<number, ProformaSlipItem>;


  // Backup data storage
  private backupSettings: Map<number, BackupSettings>;
  private scanHistoryBackups: Map<number, ScanHistoryBackup>;
  private loadingOpBackups: Map<number, LoadingOperationBackup>;
  private loadingOpBackupItems: Map<number, any[]>; // Items for backed up loading operations

  private userId: number;
  private productId: number;
  private scanId: number;
  private loadingOpId: number;
  private purchaseId: number;
  private purchaseOrderId: number;
  private purchaseOrderItemId: number;
  private proformaSlipId: number;
  private proformaSlipItemId: number;
  private vehicleInfoId: number;

  // Backup data IDs
  private backupSettingsId: number;
  private scanHistoryBackupId: number;
  private loadingOpBackupId: number;
  private proformaSlipBackupId: number;
  private proformaSlipItemBackupId: number;

  // Messages
  private messages: Map<number, Message>;
  private messageId: number;

  // Activities
  private activities: Map<number, Activity>;
  private activityId: number;

  private initialized: boolean = false;

  constructor() {
    // Initialize session store for authentication
    const MemoryStore = require('memorystore')(session);
    this.sessionStore = new MemoryStore({
      checkPeriod: 86400000, // prune expired entries every 24h
    });
    
    this.users = new Map();
    this.products = new Map();
    this.scans = new Map();
    this.loadingOps = new Map();
    this.gjOperationItems = new Map();
    this.purchases = new Map();
    this.purchaseOrders = new Map();
    this.purchaseOrderItems = new Map();
    this.proformaSlips = new Map();
    this.proformaSlipItems = new Map();


    // Initialize backup storage maps
    this.backupSettings = new Map();
    this.scanHistoryBackups = new Map();
    this.loadingOpBackups = new Map();
    this.loadingOpBackupItems = new Map();
    this.proformaSlipBackups = new Map();
    this.proformaSlipItemBackups = new Map();

    // Initialize messages map
    this.messages = new Map();

    // Initialize activities map
    this.activities = new Map();

    this.userId = 1;
    this.productId = 1;
    this.scanId = 1;
    this.loadingOpId = 1;
    this.purchaseId = 1;
    this.purchaseOrderId = 1;
    this.purchaseOrderItemId = 1;
    this.proformaSlipId = 1;
    this.proformaSlipItemId = 1;
    this.vehicleInfoId = 1;

    // Initialize backup IDs
    this.backupSettingsId = 1;
    this.scanHistoryBackupId = 1;
    this.loadingOpBackupId = 1;
    this.proformaSlipBackupId = 1;
    this.proformaSlipItemBackupId = 1;

    // Initialize message ID
    this.messageId = 1;

    // Initialize activity ID
    this.activityId = 1;

    // Initialize persistent storage
    this.init();
  }

  private async init() {
    try {
      await nodePersist.init({
        dir: './.data',
        stringify: JSON.stringify,
        parse: JSON.parse,
        encoding: 'utf8',
        logging: false,
        forgiveParseErrors: true // Enable forgiveness for parse errors
      });

      // Helper function to safely retrieve items
      const safeGetItem = async (key: string) => {
        try {
          return await nodePersist.getItem(key) || [];
        } catch (error) {
          console.error(`Error retrieving ${key}, initializing as empty array:`, error);
          // If the item can't be retrieved, reset it to avoid future errors
          await nodePersist.setItem(key, []);
          return [];
        }
      };

      // Load saved data with error handling
      const savedUsers = await safeGetItem('users');
      const savedProducts = await safeGetItem('products');
      const savedScans = await safeGetItem('scans');
      const savedLoadingOps = await safeGetItem('loadingOps');
      const savedPurchases = await safeGetItem('purchases');
      const savedProformaSlips = await safeGetItem('proformaSlips');
      const savedProformaSlipItems = await safeGetItem('proformaSlipItems');
      const savedMessages = await safeGetItem('messages');
      const savedActivities = await safeGetItem('activities');

      // Load backup data with error handling
      const savedBackupSettings = await safeGetItem('backupSettings');
      const savedScanHistoryBackups = await safeGetItem('scanHistoryBackups');
      const savedLoadingOpBackups = await safeGetItem('loadingOpBackups');
      const savedLoadingOpBackupItems = await safeGetItem('loadingOpBackupItems');
      const savedProformaSlipBackups = await safeGetItem('proformaSlipBackups'); 
      const savedProformaSlipItemBackups = await safeGetItem('proformaSlipItemBackups');

      // Helper function to safely get counter values with data integrity check
      const safeGetCounter = async (key: string, data: any[]) => {
        try {
          const value = await nodePersist.getItem(key);
          if (value !== null && value !== undefined && !isNaN(Number(value))) {
            // Get the maximum ID from actual data to ensure counter is at least that high
            const maxId = data.length > 0 ? Math.max(...data.map(item => item.id || 0)) : 0;
            // Use the higher value of stored counter or highest ID + 1
            return Math.max(Number(value), maxId + 1);
          }

          // If counter not found or invalid, calculate from data
          const maxId = data.length > 0 ? Math.max(...data.map(item => item.id || 0)) : 0;
          return Math.max(1, maxId + 1); // Ensure at least 1
        } catch (error) {
          console.error(`Error retrieving counter ${key}, calculating from data:`, error);
          // Calculate safe starting value from data
          const maxId = data.length > 0 ? Math.max(...data.map(item => item.id || 0)) : 0;
          const safeCounter = Math.max(1, maxId + 1);

          // Update the counter in storage
          await nodePersist.setItem(key, safeCounter);
          return safeCounter;
        }
      };

      // Load counters safely with data integrity checks
      this.userId = await safeGetCounter('userId', savedUsers);
      this.productId = await safeGetCounter('productId', savedProducts);
      this.scanId = await safeGetCounter('scanId', savedScans);
      this.loadingOpId = await safeGetCounter('loadingOpId', savedLoadingOps);
      this.purchaseId = await safeGetCounter('purchaseId', savedPurchases);
      this.proformaSlipId = await safeGetCounter('proformaSlipId', savedProformaSlips);
      this.proformaSlipItemId = await safeGetCounter('proformaSlipItemId', savedProformaSlipItems);
      this.messageId = await safeGetCounter('messageId', savedMessages);

      // Load backup counters safely
      this.backupSettingsId = await safeGetCounter('backupSettingsId', savedBackupSettings);
      this.scanHistoryBackupId = await safeGetCounter('scanHistoryBackupId', savedScanHistoryBackups);
      this.loadingOpBackupId = await safeGetCounter('loadingOpBackupId', savedLoadingOpBackups);
      this.proformaSlipBackupId = await safeGetCounter('proformaSlipBackupId', savedProformaSlipBackups);
      this.proformaSlipItemBackupId = await safeGetCounter('proformaSlipItemBackupId', savedProformaSlipItemBackups);

      // Populate maps
      savedUsers.forEach((user: User) => this.users.set(user.id, user));
      savedProducts.forEach((product: Product) => this.products.set(product.id, product));
      savedScans.forEach((scan: ScanHistory) => this.scans.set(scan.id, scan));
      savedLoadingOps.forEach((op: LoadingOperation) => this.loadingOps.set(op.id, op));
      savedPurchases.forEach((purchase: Purchase) => this.purchases.set(purchase.id, purchase));
      savedProformaSlips.forEach((slip: ProformaSlip) => this.proformaSlips.set(slip.id, slip));
      savedProformaSlipItems.forEach((item: ProformaSlipItem) => this.proformaSlipItems.set(item.id, item));



      // Initialize loadingOpBackupItems map from saved data
      if (savedLoadingOpBackupItems && savedLoadingOpBackupItems.length > 0) {
        for (const [savedBackupId, savedItems] of savedLoadingOpBackupItems) {
          this.loadingOpBackupItems.set(parseInt(savedBackupId), savedItems);
        }
      }

      // Populate backup maps
      savedBackupSettings.forEach((settings: BackupSettings) => this.backupSettings.set(settings.id, settings));
      savedScanHistoryBackups.forEach((backup: ScanHistoryBackup) => this.scanHistoryBackups.set(backup.id, backup));
      savedLoadingOpBackups.forEach((backup: LoadingOperationBackup) => this.loadingOpBackups.set(backup.id, backup));
      savedProformaSlipBackups.forEach((backup: ProformaSlipBackup) => this.proformaSlipBackups.set(backup.id, backup));
      savedProformaSlipItemBackups.forEach((backup: ProformaSlipItemBackup) => this.proformaSlipItemBackups.set(backup.id, backup));

      // Populate messages map
      savedMessages.forEach((message: Message) => this.messages.set(message.id, message));

      // Add default admin user if no users exist
      if (this.users.size === 0) {
        await this.createUser({
          username: "vraj@km-tribe",
          pin: "9999", // PIN set to 9999 as required
          name: "Vraj", 
          firstName: null,
          lastName: null,
          designation: null,
          department: "Management",
          accessType: null,
          role: "admin"
        });
      }

      // Create default backup settings if none exist
      if (this.backupSettings.size === 0) {
        const backupSettingsId = this.backupSettingsId++;
        const now = new Date();

        const backupSettings: BackupSettings = {
          id: backupSettingsId,
          lastBackupDate: now,
          autoBackupEnabled: true,
          backupFrequencyHours: 24,
          createdAt: now,
          updatedAt: now
        };

        this.backupSettings.set(backupSettingsId, backupSettings);
        await this.persistBackupSettings();
      }

      this.initialized = true;
      console.log('Storage initialized with persistent data');
    } catch (error) {
      console.error('Error initializing storage:', error);
    }
  }

  private async persistUsers() {
    await nodePersist.setItem('users', Array.from(this.users.values()));
    await nodePersist.setItem('userId', this.userId);
  }

  private async persistProducts() {
    await nodePersist.setItem('products', Array.from(this.products.values()));
    await nodePersist.setItem('productId', this.productId);
  }

  private async persistScans() {
    await nodePersist.setItem('scans', Array.from(this.scans.values()));
    await nodePersist.setItem('scanId', this.scanId);
  }

  private async persistLoadingOps() {
    await nodePersist.setItem('loadingOps', Array.from(this.loadingOps.values()));
    await nodePersist.setItem('loadingOpId', this.loadingOpId);
  }

  private async persistPurchases() {
    await nodePersist.setItem('purchases', Array.from(this.purchases.values()));
    await nodePersist.setItem('purchaseId', this.purchaseId);
  }


  private async persistProformaSlips() {
    await nodePersist.setItem('proformaSlips', Array.from(this.proformaSlips.values()));
    await nodePersist.setItem('proformaSlipId', this.proformaSlipId);
  }

  private async persistProformaSlipItems() {
    await nodePersist.setItem('proformaSlipItems', Array.from(this.proformaSlipItems.values()));
    await nodePersist.setItem('proformaSlipItemId', this.proformaSlipItemId);
  }

  // Backup data persistence methods
  private async persistBackupSettings() {
    await nodePersist.setItem('backupSettings', Array.from(this.backupSettings.values()));
    await nodePersist.setItem('backupSettingsId', this.backupSettingsId);
  }

  private async persistScanHistoryBackups() {
    await nodePersist.setItem('scanHistoryBackups', Array.from(this.scanHistoryBackups.values()));
    await nodePersist.setItem('scanHistoryBackupId', this.scanHistoryBackupId);
  }

  private async persistLoadingOpBackups() {
    await nodePersist.setItem('loadingOpBackups', Array.from(this.loadingOpBackups.values()));
    await nodePersist.setItem('loadingOpBackupId', this.loadingOpBackupId);
  }



  private async persistLoadingOpBackupItems() {
    // Convert Map to array format for storage
    const loadingOpBackupItemsArray = Array.from(this.loadingOpBackupItems.entries());
    await nodePersist.setItem('loadingOpBackupItems', loadingOpBackupItemsArray);
  }

  private async persistProformaSlipBackups() {
    await nodePersist.setItem('proformaSlipBackups', Array.from(this.proformaSlipBackups.values()));
    await nodePersist.setItem('proformaSlipBackupId', this.proformaSlipBackupId);
  }

  private async persistProformaSlipItemBackups() {
    await nodePersist.setItem('proformaSlipItemBackups', Array.from(this.proformaSlipItemBackups.values()));
    await nodePersist.setItem('proformaSlipItemBackupId', this.proformaSlipItemBackupId);
  }

  private async persistMessages() {
    await nodePersist.setItem('messages', Array.from(this.messages.values()));
    await nodePersist.setItem('messageId', this.messageId);
  }

  private async persistActivities() {
    await nodePersist.setItem('activities', Array.from(this.activities.values()));
    await nodePersist.setItem('activityId', this.activityId);
  }

  // User operations
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async getUserByUserCode(userCode: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.userCode === userCode,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    // Check for duplicate PIN if provided
    if (insertUser.pin) {
      const existingUserWithPin = Array.from(this.users.values()).find(user => user.pin === insertUser.pin);
      if (existingUserWithPin) {
        throw new Error(`PIN ${insertUser.pin} is already used by another user. Please choose a different PIN.`);
      }
    }
    
    const id = this.userId++;
    // Convert any undefined values to null
    const processedInsertUser = Object.fromEntries(
      Object.entries(insertUser).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const user: User = { ...processedInsertUser as any, id };
    this.users.set(id, user);

    // Persist to storage
    await this.persistUsers();

    return user;
  }

  async updateUser(userCode: string, userUpdate: Partial<InsertUser>): Promise<User | undefined> {
    // Find user by userCode
    const existingUser = Array.from(this.users.values()).find(u => u.userCode === userCode);
    if (!existingUser) return undefined;
    
    return this.updateUserById(existingUser.id, userUpdate);
  }
  
  async updateUserById(id: number, userUpdate: Partial<InsertUser>): Promise<User | undefined> {
    const existingUser = this.users.get(id);
    if (!existingUser) return undefined;

    // Check for duplicate PIN if PIN is being updated
    if (userUpdate.pin) {
      const existingUserWithPin = Array.from(this.users.values()).find(user => 
        user.pin === userUpdate.pin && user.id !== id
      );
      if (existingUserWithPin) {
        throw new Error(`PIN ${userUpdate.pin} is already used by another user. Please choose a different PIN.`);
      }
    }

    // Convert any undefined values to null
    const processedUpdate = Object.fromEntries(
      Object.entries(userUpdate).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const updatedUser = {
      ...existingUser,
      ...processedUpdate,
    };

    this.users.set(id, updatedUser);

    // Persist to storage
    await this.persistUsers();

    return updatedUser;
  }
  
  async updateUserPin(userCode: string, pin: string): Promise<User | undefined> {
    console.log(`Updating PIN for user code ${userCode} in MemStorage`);
    
    // Find user by userCode
    const existingUser = Array.from(this.users.values()).find(u => u.userCode === userCode);
    if (!existingUser) return undefined;
    
    const id = existingUser.id;
    
    // Check for duplicate PIN
    const existingUserWithPin = Array.from(this.users.values()).find(user => 
      user.pin === pin && user.id !== id
    );
    if (existingUserWithPin) {
      throw new Error(`PIN ${pin} is already used by user "${existingUserWithPin.name || existingUserWithPin.username}". Please choose a different PIN.`);
    }

    const updatedUser = {
      ...existingUser,
      pin,
    };

    this.users.set(id, updatedUser);

    // Persist to storage
    await this.persistUsers();

    return updatedUser;
  }

  async deleteUser(userCode: string): Promise<boolean> {
    // Find user by userCode
    const existingUser = Array.from(this.users.values()).find(u => u.userCode === userCode);
    if (!existingUser) return false;
    
    return this.deleteUserById(existingUser.id);
  }
  
  async deleteUserById(id: number): Promise<boolean> {
    const result = this.users.delete(id);

    // Persist to storage
    if (result) {
      await this.persistUsers();
    }

    return result;
  }

  async listUsers(limit = 10, offset = 0): Promise<User[]> {
    return Array.from(this.users.values())
      .slice(offset, offset + limit);
  }

  // Product operations
  async getProduct(id: number): Promise<Product | undefined> {
    return this.products.get(id);
  }

  async getProductByBarcode(barcode: string): Promise<Product | undefined> {
    return Array.from(this.products.values()).find(
      (product) => product.barcode === barcode,
    );
  }

  async getProductByName(name: string): Promise<Product | undefined> {
    const normalized = name.trim().toLowerCase();
    return Array.from(this.products.values()).find(
      (product) => product.name?.trim().toLowerCase() === normalized,
    );
  }

  async getProductsByIds(ids: number[]): Promise<Product[]> {
    if (!ids || ids.length === 0) return [];
    
    const foundProducts: Product[] = [];
    
    for (const id of ids) {
      const product = this.products.get(id);
      if (product) {
        foundProducts.push(product);
      }
    }
    
    return foundProducts;
  }

  async createProduct(insertProduct: InsertProduct): Promise<Product> {
    const id = this.productId++;
    const now = new Date();

    // Convert undefined values to null
    const processedProduct = Object.fromEntries(
      Object.entries(insertProduct).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const product: Product = { 
      ...processedProduct as any,
      id,
      createdAt: now,
      updatedAt: now // Add the required updatedAt field
    };

    this.products.set(id, product);

    // Persist to storage
    await this.persistProducts();

    return product;
  }

  async updateProduct(id: number, productUpdate: Partial<InsertProduct>): Promise<Product | undefined> {
    const existingProduct = this.products.get(id);
    if (!existingProduct) return undefined;

    // Convert undefined values to null
    const processedUpdate = Object.fromEntries(
      Object.entries(productUpdate).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const updatedProduct = {
      ...existingProduct,
      ...processedUpdate,
      updatedAt: new Date() // Update the updatedAt field
    };

    this.products.set(id, updatedProduct);

    // Persist to storage
    await this.persistProducts();

    return updatedProduct;
  }

  async deleteProduct(id: number): Promise<boolean> {
    const result = this.products.delete(id);

    // Persist to storage if deletion was successful
    if (result) {
      await this.persistProducts();
    }

    return result;
  }

  async listProducts(limit = 10, offset = 0): Promise<Product[]> {
    return Array.from(this.products.values())
      .sort((a, b) => {
        // Handle dates that might be strings when loaded from storage
        const dateA = a.createdAt instanceof Date ? a.createdAt : a.createdAt ? new Date(a.createdAt) : null;
        const dateB = b.createdAt instanceof Date ? b.createdAt : b.createdAt ? new Date(b.createdAt) : null;

        return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
      })
      .slice(offset, offset + limit);
  }

  async getNotionProductsPage(params: NotionProductsQuery): Promise<{ products: Product[]; total: number }> {
    const { page, pageSize, search, category, brand, plant, type, saleCategory, linkedOnly } = params;
    let all = Array.from(this.products.values());
    if (linkedOnly) all = all.filter(p => p.notionPageId);
    if (search?.trim()) {
      const q = search.trim().toLowerCase();
      all = all.filter(p =>
        [p.name, p.barcode, p.srNo, p.newSr, p.notionWiseName, p.brand].some(v => v?.toLowerCase().includes(q))
      );
    }
    if (category) all = all.filter(p => p.category === category);
    if (brand) all = all.filter(p => p.brand === brand);
    if (plant) all = all.filter(p => p.plant === plant);
    if (type) all = all.filter(p => p.type === type);
    if (saleCategory) all = all.filter(p => p.saleCategory === saleCategory);
    const total = all.length;
    const offset = (page - 1) * pageSize;
    return { products: all.slice(offset, offset + pageSize), total };
  }

  async getNotionProductFilterOptions(): Promise<{ categories: string[]; brands: string[]; plants: string[]; types: string[]; saleCategories: string[] }> {
    const all = Array.from(this.products.values());
    const unique = (fn: (p: Product) => string | null | undefined) =>
      [...new Set(all.map(fn).filter(Boolean) as string[])].sort();
    return {
      categories: unique(p => p.category),
      brands: unique(p => p.brand),
      plants: unique(p => p.plant),
      types: unique(p => p.type),
      saleCategories: unique(p => p.saleCategory),
    };
  }

  // Scan history operations
  async createScanHistory(insertScan: InsertScanHistory): Promise<ScanHistory> {
    const id = this.scanId++;
    const now = new Date();

    // Convert undefined values to null
    const processedScan = Object.fromEntries(
      Object.entries(insertScan).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const scan: ScanHistory = {
      ...processedScan as any,
      id,
      scannedAt: now,
    };

    this.scans.set(id, scan);

    // Persist to storage
    await this.persistScans();

    return scan;
  }

  async getScanHistory(id: number): Promise<ScanHistory | undefined> {
    return this.scans.get(id);
  }

  async deleteScanHistory(id: number): Promise<boolean> {
    const result = this.scans.delete(id);

    // Persist to storage if deletion was successful
    if (result) {
      await this.persistScans();
    }

    return result;
  }

  async listScanHistory(limit = 10, offset = 0): Promise<ScanHistory[]> {
    return Array.from(this.scans.values())
      .sort((a, b) => {
        // Handle dates that might be strings when loaded from storage
        const dateA = a.scannedAt instanceof Date ? a.scannedAt : a.scannedAt ? new Date(a.scannedAt) : null;
        const dateB = b.scannedAt instanceof Date ? b.scannedAt : b.scannedAt ? new Date(b.scannedAt) : null;

        return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
      })
      .slice(offset, offset + limit);
  }

  // Loading operations
  async createLoadingOperation(insertOperation: InsertLoadingOperation): Promise<LoadingOperation> {
    const id = this.loadingOpId++;
    const now = new Date();

    // Convert undefined values to null
    const processedOperation = Object.fromEntries(
      Object.entries(insertOperation).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const operation: LoadingOperation = {
      ...processedOperation as any,
      id,
      createdAt: now,
      completedAt: null,
    };

    this.loadingOps.set(id, operation);

    // Persist to storage
    await this.persistLoadingOps();

    return operation;
  }

  async getLoadingOperation(id: number): Promise<LoadingOperation | undefined> {
    return this.loadingOps.get(id);
  }

  async getLoadingOperationByReferenceNumber(referenceNumber: string): Promise<LoadingOperation| undefined> {
    return Array.from(this.loadingOps.values()).find(
      (operation) => operation.referenceNumber === referenceNumber
    );
  }

  async updateLoadingOperation(id: number, operationUpdate: Partial<InsertLoadingOperation>): Promise<LoadingOperation | undefined> {
    const existingOperation = this.loadingOps.get(id);
    if (!existingOperation) return undefined;

    // Convert undefined values to null
    const processedUpdate = Object.fromEntries(
      Object.entries(operationUpdate).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const updatedOperation = {
      ...existingOperation,
      ...processedUpdate,
    };

    this.loadingOps.set(id, updatedOperation);

    // Persist to storage
    await this.persistLoadingOps();

    return updatedOperation;
  }

  async deleteLoadingOperation(id: number): Promise<boolean> {
    const result = this.loadingOps.delete(id);

    // Persist to storage if deletion was successful
    if (result) {
      await this.persistLoadingOps();
    }

    return result;
  }

  async listLoadingOperations(limit = 10, offset = 0, startDate?: Date, endDate?: Date): Promise<LoadingOperation[]> {
    let loadingOperations = Array.from(this.loadingOps.values());

    // Apply date filtering if specified
    if (startDate && endDate) {
      loadingOperations = loadingOperations.filter(op => {
        const opDate = op.createdAt instanceof Date ? op.createdAt : op.createdAt ? new Date(op.createdAt) : null;
        if (!opDate) return false;

        return opDate >= startDate && opDate <= endDate;
      });
    }

    return loadingOperations
      .sort((a, b) => {
        // Handle dates that might be strings when loaded from storage
        const dateA = a.createdAt instanceof Date ? a.createdAt : a.createdAt ? new Date(a.createdAt) : null;
        const dateB = b.createdAt instanceof Date ? b.createdAt : b.createdAt ? new Date(b.createdAt) : null;

        return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
      })
      .slice(offset, offset + limit);
  }

  async countLoadingOperationsByStatus(status: string): Promise<number> {
    return Array.from(this.loadingOps.values())
      .filter(op => op.status === status)
      .length;
  }

  async getGJOperationItems(loadingOperationId: number): Promise<LoadingOpItem[]> {
    // Return items for the specified load operation from the gjOperationItems map
    // If no items found, return an empty array
    return this.gjOperationItems.get(loadingOperationId) || [];
  }

  // Purchase operations
  async createPurchase(insertPurchase: InsertPurchase): Promise<Purchase> {
    const id = this.purchaseId++;
    const now = new Date();

    // Convert undefined values to null
    const processedPurchase = Object.fromEntries(
      Object.entries(insertPurchase).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const purchase: Purchase = {
      ...processedPurchase as any,
      id,
      createdAt: now,
    };

    this.purchases.set(id, purchase);

    // Persist to storage
    await this.persistPurchases();

    return purchase;
  }

  async getPurchase(id: number): Promise<Purchase | undefined> {
    return this.purchases.get(id);
  }

  async updatePurchase(id: number, purchaseUpdate: Partial<InsertPurchase>): Promise<Purchase | undefined> {
    const existingPurchase = this.purchases.get(id);
    if (!existingPurchase) return undefined;

    // Convert undefined values to null
    const processedUpdate = Object.fromEntries(
      Object.entries(purchaseUpdate).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const updatedPurchase = {
      ...existingPurchase,
      ...processedUpdate,
    };

    this.purchases.set(id, updatedPurchase);

    // Persist to storage
    await this.persistPurchases();

    return updatedPurchase;
  }

  async deletePurchase(id: number): Promise<boolean> {
    const result = this.purchases.delete(id);

    // Persist to storage if deletion was successful
    if (result) {
      await this.persistPurchases();
    }

    return result;
  }

  async listPurchases(limit = 10, offset = 0): Promise<Purchase[]> {
    return Array.from(this.purchases.values())
      .sort((a, b) => {
        // Handle dates that might be strings when loaded from storage
        const dateA = a.createdAt instanceof Date ? a.createdAt : a.createdAt ? new Date(a.createdAt) : null;
        const dateB = b.createdAt instanceof Date ? b.createdAt : b.createdAt ? new Date(b.createdAt) : null;

        return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
      })
      .slice(offset, offset + limit);
  }


  // Clear all inventory data
  async clearInventory(): Promise<void> {
    // Clear the products map
    this.products.clear();

    // Reset the product ID counter
    this.productId = 1;

    // Persist the empty products and updated counter
    await this.persistProducts();

    console.log('Inventory data cleared successfully');
  }

  // Reset all inStock and sold values to zero
  async resetInventoryStock(): Promise<number> {
    let updatedCount = 0;

    // Get all products as an array
    const products = Array.from(this.products.values());

    // Update all products to have inStock = 0 and sold = 0
    products.forEach(product => {
      this.products.set(product.id, {
        ...product,
        inStock: 0,
        sold: 0,
        lastUpdated: new Date()
      });
      updatedCount++;
    });

    // Persist the updated products
    await this.persistProducts();

    console.log(`Reset inStock and sold values to zero for ${updatedCount} products`);
    return updatedCount;
  }

  // Method to reset only the sold counts to zero
  async resetSoldCounts(): Promise<number> {
    let updatedCount = 0;

    // Get all products as an array
    const products = Array.from(this.products.values());

    // Update all products to have sold = 0 (but keep inStock as is)
    products.forEach(product => {
      this.products.set(product.id, {
        ...product,
        sold: 0,
        lastUpdated: new Date()
      });
      updatedCount++;
    });

    // Persist the updated products
    await this.persistProducts();

    console.log(`Reset sold counts to zero for ${updatedCount} products`);
    return updatedCount;
  };

  // Activity tracking operations - using database only
  async createActivity(activity: InsertActivity): Promise<Activity> {
    // Use the database directly
    return await db.insert(activities).values(activity).returning().then(res => res[0]);
  }

  async getActivity(id: number): Promise<Activity | undefined> {
    // Use the database directly
    return await db.select().from(activities).where(eq(activities.id, id)).then(res => res[0]);
  }

  async deleteActivity(id: number): Promise<boolean> {
    // Use the database directly
    return await db.delete(activities).where(eq(activities.id, id)).then(() => true);
  }

  async deleteOldActivities(daysToKeep: number = 30): Promise<number> {
    // Calculate cutoff date (activities older than this will be deleted)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    // Delete activities older than the cutoff date
    const result = await db.delete(activities)
      .where(lt(activities.createdAt, cutoffDate))
      .returning({ id: activities.id });

    console.log(`Deleted ${result.length} activities older than ${daysToKeep} days (before ${cutoffDate.toISOString()})`);
    return result.length;
  }

  async deleteTestActivities(): Promise<number> {
    // Delete activities with pageName='Test' or action='test'
    const result = await db.delete(activities)
      .where(or(
        eq(activities.pageName, 'Test'),
        eq(activities.action, 'test')
      ))
      .returning({ id: activities.id });

    console.log(`Deleted ${result.length} test activities`);
    return result.length;
  }

  async listActivities(limit = 100, offset = 0): Promise<Activity[]> {
    // Use the database directly
    return await db.select().from(activities).orderBy(desc(activities.createdAt)).limit(limit).offset(offset);
  }

  async getActivitiesByPage(pageName: string, limit = 100, offset = 0): Promise<Activity[]> {
    // Use the database directly
    return await db.select().from(activities)
      .where(eq(activities.pageName, pageName))
      .orderBy(desc(activities.createdAt))
      .limit(limit).offset(offset);
  }

  async getActivitiesByAction(action: string, limit = 100, offset = 0): Promise<Activity[]> {
    // Use the database directly
    return await db.select().from(activities)
      .where(eq(activities.action, action))
      .orderBy(desc(activities.createdAt))
      .limit(limit).offset(offset);
  }

  async getEntityActivities(entityType: string, entityId: string, limit = 100): Promise<Activity[]> {
    // Use the database directly
    return await db.select().from(activities)
      .where(and(
        eq(activities.entityType, entityType),
        eq(activities.entityId, entityId)
      ))
      .orderBy(desc(activities.createdAt))
      .limit(limit);
  }



  // Backup settings operations
  async getBackupSettings(): Promise<BackupSettings | undefined> {
    // Since we should only have one settings entry, get the first one
    return Array.from(this.backupSettings.values())[0];
  }

  async createBackupSettings(settings: InsertBackupSettings): Promise<BackupSettings> {
    const id = this.backupSettingsId++;
    const now = new Date();

    // Convert undefined values to null
    const processedSettings = Object.fromEntries(
      Object.entries(settings).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const backupSettings: BackupSettings = {
      ...processedSettings as any,
      id,
      createdAt: now,
      updatedAt: now
    };

    this.backupSettings.set(id, backupSettings);

    // Persist to storage
    await this.persistBackupSettings();

    return backupSettings;
  }

  async updateBackupSettings(id: number, settingsUpdate: Partial<InsertBackupSettings>): Promise<BackupSettings | undefined> {
    const existingSettings = this.backupSettings.get(id);
    if (!existingSettings) return undefined;

    // Convert undefined values to null
    const processedUpdate = Object.fromEntries(
      Object.entries(settingsUpdate).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const updatedSettings = {
      ...existingSettings,
      ...processedUpdate,
      updatedAt: new Date()
    };

    this.backupSettings.set(id, updatedSettings);

    // Persist to storage
    await this.persistBackupSettings();

    return updatedSettings;
  }

  // Backup operations for scan history
  async backupScanHistory(scanHistoryId: number): Promise<ScanHistoryBackup> {
    const scanHistory = this.scans.get(scanHistoryId);
    if (!scanHistory) {
      throw new Error(`Scan history record with ID ${scanHistoryId} not found`);
    }

    // Create backup record
    const backupId = this.scanHistoryBackupId++;
    const backupRecord: ScanHistoryBackup = {
      id: backupId,
      originalId: scanHistory.id,
      barcode: scanHistory.barcode,
      productId: scanHistory.productId,
      productName: scanHistory.productName,
      productSku: scanHistory.productSku,
      scannedById: scanHistory.scannedById,
      scannerName: scanHistory.scannerName,
      scannerDepartment: scanHistory.scannerDepartment,
      scannedAt: scanHistory.scannedAt,
      action: scanHistory.action,
      quantity: scanHistory.quantity,
      notes: scanHistory.notes,
      backupDate: new Date()
    };

    // Add to backup storage
    this.scanHistoryBackups.set(backupId, backupRecord);

    // Mark original as backed up
    const updatedScanHistory = {
      ...scanHistory,
      isBackedUp: true
    };
    this.scans.set(scanHistoryId, updatedScanHistory);

    // Persist both updates
    await this.persistScanHistoryBackups();
    await this.persistScans();

    return backupRecord;
  }

  // Backup operations for loading operations
  async backupLoadingOperation(loadingOperationId: number): Promise<LoadingOperationBackup> {
    const loadingOperation = this.loadingOps.get(loadingOperationId);
    if (!loadingOperation) {
      throw new Error(`Loading operation with ID ${loadingOperationId} not found`);
    }

    // Create backup record
    const backupId = this.loadingOpBackupId++;

    // Find associated proforma slip to get vehicle number
    let vehicleNumber = null;
    if (loadingOperation.referenceNumber) {
      const proformaSlip = Array.from(this.proformaSlips.values()).find(
        slip => slip.orderNumber === loadingOperation.referenceNumber
      );
      if (proformaSlip && proformaSlip.vehicleNumber) {
        vehicleNumber = proformaSlip.vehicleNumber;
      }
    }

    const backupRecord: LoadingOperationBackup = {
      id: backupId,
      originalId: loadingOperation.id,
      status: loadingOperation.status,
      referenceNumber: loadingOperation.referenceNumber,
      vehicleNumber,
      createdById: loadingOperation.createdById,
      createdAt: loadingOperation.createdAt,
      completedAt: loadingOperation.completedAt,
      notes: loadingOperation.notes,
      backupDate: new Date()
    };

    // Add to backup storage
    this.loadingOpBackups.set(backupId, backupRecord);

    // Mark original as backed up
    const updatedLoadingOperation = {
      ...loadingOperation,
      isBackedUp: true
    };
    this.loadingOps.set(loadingOperationId, updatedLoadingOperation);

    // Check if we need to backup related items (proforma slip items)
    if (loadingOperation.referenceNumber) {
      // Find the proforma slip with this order number
      const proformaSlip = Array.from(this.proformaSlips.values()).find(
        slip => slip.orderNumber === loadingOperation.referenceNumber
      );

      if (proformaSlip) {
        // Get all items for this proforma slip
        const items = Array.from(this.proformaSlipItems.values()).filter(
          item => item.proformaSlipId === proformaSlip.id
        );

        // Store these items for this backup
        if (items && items.length > 0) {
          this.loadingOpBackupItems.set(backupId, items);
          await this.persistLoadingOpBackupItems();
        }
      }
    }

    // Persist both updates
    await this.persistLoadingOpBackups();
    await this.persistLoadingOps();

    return backupRecord;
  }


  // Proforma Slip operations
  async createProformaSlip(insertSlip: InsertProformaSlip): Promise<ProformaSlip> {
    const id = this.proformaSlipId++;
    const now = new Date();

    // Convert undefined values to null
    const processedSlip = Object.fromEntries(
      Object.entries(insertSlip).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const slip: ProformaSlip = {
      ...processedSlip as any,
      id,
      createdAt: now,
    };

    this.proformaSlips.set(id, slip);

    // Persist to storage
    await this.persistProformaSlips();

    return slip;
  }

  async getProformaSlip(id: number): Promise<ProformaSlip | undefined> {
    return this.proformaSlips.get(id);
  }

  async getProformaSlipByOrderNumber(orderNumber: string): Promise<ProformaSlip | undefined> {
    return Array.from(this.proformaSlips.values()).find(
      (slip) => slip.orderNumber === orderNumber
    );
  }

  async getProformaSlipsByOrderNumbers(orderNumbers: string[]): Promise<ProformaSlip[]> {
    if (!orderNumbers.length) return [];

    return Array.from(this.proformaSlips.values()).filter(
      (slip) => slip.orderNumber && orderNumbers.includes(slip.orderNumber)
    );
  }

  async updateProformaSlip(id: number, slipUpdate: Partial<InsertProformaSlip>): Promise<ProformaSlip | undefined> {
    console.log(`[storage] updateProformaSlip called with id: ${id}, update:`, slipUpdate);

    const existingSlip = this.proformaSlips.get(id);
    if (!existingSlip) {
      console.log(`[storage] No slip found with id: ${id}`);
      return undefined;
    }

    console.log(`[storage] Existing slip:`, existingSlip);

    // Convert undefined values to null
    const processedUpdate = Object.fromEntries(
      Object.entries(slipUpdate).map(([key, value]) => [key, value === undefined ? null : value])
    );

    console.log(`[storage] Processed update:`, processedUpdate);

    const updatedSlip = {
      ...existingSlip,
      ...processedUpdate,
    };

    console.log(`[storage] Updated slip (before saving):`, updatedSlip);

    this.proformaSlips.set(id, updatedSlip);

    // Persist to storage
    await this.persistProformaSlips();

    // Verify the updated slip was saved correctly
    const verifiedSlip = this.proformaSlips.get(id);
    console.log(`[storage] Verified slip after save:`, verifiedSlip);

    return updatedSlip;
  }

  async deleteProformaSlip(id: number): Promise<boolean> {
    const result = this.proformaSlips.delete(id);

    // If slip is deleted successfully, also delete all related items
    if (result) {
      // Find and delete all items for this slip
      const itemsToDelete = Array.from(this.proformaSlipItems.values())
        .filter(item => item.proformaSlipId === id)
        .map(item => item.id);

      itemsToDelete.forEach(itemId => this.proformaSlipItems.delete(itemId));

      // Persist both slips and items
      await this.persistProformaSlips();
      await this.persistProformaSlipItems();
    }

    return result;
  }

  async listProformaSlips(limit = 10, offset = 0): Promise<ProformaSlip[]> {
    return Array.from(this.proformaSlips.values())
      .sort((a, b) => {
        // Handle dates that might be strings when loaded from storage
        const dateA = a.createdAt instanceof Date ? a.createdAt : a.createdAt ? new Date(a.createdAt) : null;
        const dateB = b.createdAt instanceof Date ? b.createdAt : b.createdAt ? new Date(b.createdAt) : null;

        return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
      })
      .slice(offset, offset + limit);
  }

  // Proforma Slip Item operations
  async createProformaSlipItem(insertItem: InsertProformaSlipItem): Promise<ProformaSlipItem> {
    const id = this.proformaSlipItemId++;
    const now = new Date();

    // Convert undefined values to null
    const processedItem = Object.fromEntries(
      Object.entries(insertItem).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const item: ProformaSlipItem = {
      ...processedItem as any,
      id,
      createdAt: now,
    };

    this.proformaSlipItems.set(id, item);

    // Persist to storage
    await this.persistProformaSlipItems();

    return item;
  }

  async getProformaSlipItems(proformaSlipId: number): Promise<ProformaSlipItem[]> {
    return Array.from(this.proformaSlipItems.values())
      .filter(item => item.proformaSlipId === proformaSlipId);
  }

  async getProformaSlipItemsByIds(itemIds: number[]): Promise<ProformaSlipItem[]> {
    return Array.from(this.proformaSlipItems.values())
      .filter(item => itemIds.includes(item.id));
  }

  async updateProformaSlipItem(id: number, itemUpdate: Partial<InsertProformaSlipItem>): Promise<ProformaSlipItem | undefined> {
    const existingItem = this.proformaSlipItems.get(id);
    if (!existingItem) return undefined;

    // Convert undefined values to null
    const processedUpdate = Object.fromEntries(
      Object.entries(itemUpdate).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const updatedItem = {
      ...existingItem,
      ...processedUpdate,
    };

    this.proformaSlipItems.set(id, updatedItem);

    // Persist to storage
    await this.persistProformaSlipItems();

    return updatedItem;
  }

  async deleteProformaSlipItem(id: number): Promise<boolean> {
    const result = this.proformaSlipItems.delete(id);

    // Persist to storage if deletion was successful
    if (result) {
      await this.persistProformaSlipItems();
    }

    return result;
  }

  // List historical data with date filtering
  async listScanHistoryBackups(startDate?: Date, endDate?: Date, limit = 100, offset = 0): Promise<ScanHistoryBackup[]> {
    return Array.from(this.scanHistoryBackups.values())
      .filter(backup => {
        if (!startDate && !endDate) return true;

        // Safely handle nullable date
        if (!backup.backupDate) return false;

        const backupDate = backup.backupDate instanceof Date 
          ? backup.backupDate 
          : new Date(backup.backupDate);

        if (startDate && endDate) {
          return backupDate >= startDate && backupDate <= endDate;
        } else if (startDate) {
          return backupDate >= startDate;
        } else if (endDate) {
          return backupDate <= endDate;
        }

        return true;
      })
      .sort((a, b) => {
        // Safely handle nullable dates
        if (!a.backupDate) return 1;  // Sort nulls to the end
        if (!b.backupDate) return -1; // Sort nulls to the end

        const dateA = a.backupDate instanceof Date ? a.backupDate : new Date(a.backupDate);
        const dateB = b.backupDate instanceof Date ? b.backupDate : new Date(b.backupDate);
        return dateB.getTime() - dateA.getTime(); // Sort from newest to oldest
      })
      .slice(offset, offset + limit);
  }

  async listLoadingOperationBackups(startDate?: Date, endDate?: Date, limit = 100, offset = 0, orderDate?: Date): Promise<LoadingOperationBackup[]> {
    // First check for orderDate parameter (exact date filter)
    if (orderDate) {
      const startOfDay = new Date(orderDate);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(orderDate);
      endOfDay.setHours(23, 59, 59, 999);

      return Array.from(this.loadingOpBackups.values())
        .filter(backup => {
          if (!backup.orderDate) return false;

          const date = backup.orderDate instanceof Date
            ? backup.orderDate
            : new Date(backup.orderDate);

          return date >= startOfDay && date <= endOfDay;
        })
        .sort((a, b) => {
          const dateA = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt || 0);
          const dateB = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt || 0);
          return dateB.getTime() - dateA.getTime();
        })
        .slice(offset, offset + limit);
    }

    // Then check for date range parameters
    return Array.from(this.loadingOpBackups.values())
      .filter(backup => {
        if (!startDate && !endDate) return true;

        // Safely handle nullable date
        if (!backup.backupDate) return false;

        const backupDate = backup.backupDate instanceof Date 
          ? backup.backupDate 
          : new Date(backup.backupDate);

        if (startDate && endDate) {
          return backupDate >= startDate && backupDate <= endDate;
        } else if (startDate) {
          return backupDate >= startDate;
        } else if (endDate) {
          return backupDate <= endDate;
        }

        return true;
      })
      .sort((a, b) => {
        // Safely handle nullable dates
        if (!a.backupDate) return 1;  // Sort nulls to the end
        if (!b.backupDate) return -1; // Sort nulls to the end

        const dateA = a.backupDate instanceof Date ? a.backupDate : new Date(a.backupDate);
        const dateB = b.backupDate instanceof Date ? b.backupDate : new Date(b.backupDate);
        return dateB.getTime() - dateA.getTime(); // Sort from newest to oldest
      })
      .slice(offset, offset + limit);
  }

  // Get items for a loading operation backup
  async getLoadingOperationBackupItems(backupId: number): Promise<any[]> {
    try {
      // If we have a direct mapping of backup loading operation items, use that
      if (this.loadingOpBackupItems.has(backupId)) {
        return this.loadingOpBackupItems.get(backupId) || [];
      }

      // Otherwise, check if the backup corresponds to an existing loading operation
      const backup = this.loadingOpBackups.get(backupId);
      if (!backup) return [];

      // If the backup has an originalId, try to get items from the proforma slip
      if (backup.originalId && backup.referenceNumber) {
        // We need to find the proforma slip that matches the reference number
        const proformaSlip = Array.from(this.proformaSlips.values()).find(
          slip => slip.orderNumber === backup.referenceNumber
        );

        if (proformaSlip) {
          // Get all items for this proforma slip
          const items = Array.from(this.proformaSlipItems.values()).filter(
            item => item.proformaSlipId === proformaSlip.id
          );

          // Cache these items in the backup items map for future use
          if (items && items.length > 0) {
            this.loadingOpBackupItems.set(backupId, items);
            await this.persistLoadingOpBackupItems();
          }

          return items;
        }
      }

      return [];
    } catch (error) {
      console.error("Error getting backup loading operation items:", error);
      return [];
    }
  }

  // Delete a loading operation backup by ID
  async deleteLoadingOperationBackup(backupId: number): Promise<boolean> {
    try {
      // Check if the backup exists
      if (!this.loadingOpBackups.has(backupId)) {
        return false;
      }

      // Delete the backup
      this.loadingOpBackups.delete(backupId);

      // Also delete any associated backup items
      if (this.loadingOpBackupItems.has(backupId)) {
        this.loadingOpBackupItems.delete(backupId);
        await this.persistLoadingOpBackupItems();
      }

      // Persist the changes
      await this.persistLoadingOpBackups();

      return true;
    } catch (error) {
      console.error(`Error deleting loading operation backup with ID ${backupId}:`, error);
      return false;
    }
  }


  // Run a backup operation
  async backupProformaSlip(proformaSlipId: number): Promise<ProformaSlipBackup> {
    const slip = this.proformaSlips.get(proformaSlipId);
    if (!slip) {
      throw new Error(`Proforma slip with ID ${proformaSlipId} not found`);
    }

    // Mark original as backed up
    const updatedSlip = {
      ...slip,
      isBackedUp: true
    };
    this.proformaSlips.set(proformaSlipId, updatedSlip);
    await this.persistProformaSlips();

    // Create a backup entry
    const backupIds = Array.from(this.proformaSlipBackups.values()).map(b => b.id);
    const nextBackupId = backupIds.length > 0 ? Math.max(...backupIds) + 1 : 1;
    const backup: ProformaSlipBackup = {
      id: nextBackupId,
      originalId: slip.id,
      orderDate: slip.orderDate,
      orderNumber: slip.orderNumber,
      partyName: slip.partyName,
      plant: slip.plant,
      totalQuantity: slip.totalQuantity,
      totalVolume: slip.totalVolume,
      vehicleNumber: slip.vehicleNumber,
      driverName: slip.driverName,
      createdById: slip.createdById,
      createdAt: slip.createdAt,
      notes: slip.notes,
      backupDate: new Date()
    };

    // Save the backup entry
    this.proformaSlipBackups.set(nextBackupId, backup);
    await this.persistProformaSlipBackups();

    // Also back up all items for this slip
    const items = Array.from(this.proformaSlipItems.values())
      .filter(item => item.proformaSlipId === proformaSlipId);

    for (const item of items) {
      // Mark item as backed up
      const updatedItem = {
        ...item,
        isBackedUp: true
      };
      this.proformaSlipItems.set(item.id, updatedItem);

      // And create a backup of the item
      await this.backupProformaSlipItem(item.id, nextBackupId);
    }

    // Persist the updated items
    await this.persistProformaSlipItems();

    return backup;
  }

  async backupProformaSlipItem(slipItemId: number, proformaSlipBackupId: number): Promise<ProformaSlipItemBackup> {
    const item = this.proformaSlipItems.get(slipItemId);
    if (!item) {
      throw new Error(`Proforma slip item with ID ${slipItemId} not found`);
    }

    // Mark original as backed up
    const updatedItem = {
      ...item,
      isBackedUp: true
    };
    this.proformaSlipItems.set(slipItemId, updatedItem);
    await this.persistProformaSlipItems();

    // Create a backup entry
    const itemBackupIds = Array.from(this.proformaSlipItemBackups.values()).map(b => b.id);
    const nextBackupId = itemBackupIds.length > 0 ? Math.max(...itemBackupIds) + 1 : 1;
    const backup: ProformaSlipItemBackup = {
      id: nextBackupId,
      originalId: item.id,
      proformaSlipId: item.proformaSlipId, 
      proformaSlipBackupId: proformaSlipBackupId,
      productId: item.productId,
      quantity: item.quantity,
      loaded: item.loaded,
      createdAt: item.createdAt,
      backupDate: new Date()
    };

    // Save the backup entry
    this.proformaSlipItemBackups.set(nextBackupId, backup);
    await this.persistProformaSlipItemBackups();

    return backup;
  }

  async listProformaSlipBackups(startDate?: Date, endDate?: Date, limit = 100, offset = 0): Promise<ProformaSlipBackup[]> {
    let backups = Array.from(this.proformaSlipBackups.values());

    // Apply date filters if provided
    if (startDate) {
      backups = backups.filter(backup => {
        if (!backup.createdAt) return false;
        const backupDate = backup.createdAt instanceof Date ? backup.createdAt : new Date(backup.createdAt);
        return backupDate >= startDate;
      });
    }

    if (endDate) {
      backups = backups.filter(backup => {
        if (!backup.createdAt) return false;
        const backupDate = backup.createdAt instanceof Date ? backup.createdAt : new Date(backup.createdAt);
        return backupDate <= endDate;
      });
    }

    // Sort by creation date (newest first)
    backups.sort((a, b) => {
      // Handle missing dates
      if (!a.createdAt && !b.createdAt) return 0;
      if (!a.createdAt) return 1; // null dates sort to the end
      if (!b.createdAt) return -1;

      const dateA = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt);
      const dateB = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime();
    });

    // Apply pagination
    return backups.slice(offset, offset + limit);
  }

  async listProformaSlipItemBackups(proformaSlipBackupId: number): Promise<ProformaSlipItemBackup[]> {
    return Array.from(this.proformaSlipItemBackups.values())
      .filter(item => item.proformaSlipBackupId === proformaSlipBackupId);
  }

  // Delete a proforma slip backup by ID
  async deleteProformaSlipBackup(backupId: number): Promise<boolean> {
    try {
      // Check if the backup exists
      if (!this.proformaSlipBackups.has(backupId)) {
        return false;
      }

      // Delete the backup
      this.proformaSlipBackups.delete(backupId);

      // Delete associated proforma slip item backups
      const itemBackups = await this.listProformaSlipItemBackups(backupId);
      for (const itemBackup of itemBackups) {
        this.proformaSlipItemBackups.delete(itemBackup.id);
      }

      // Persist the changes
      await this.persistProformaSlipBackups();
      await this.persistProformaSlipItemBackups();

      return true;
    } catch (error) {
      console.error(`Error deleting proforma slip backup with ID ${backupId}:`, error);
      return false;
    }
  }

  // Delete multiple proforma slip backups by ID
  async deleteProformaSlipBackups(backupIds: number[]): Promise<number> {
    try {
      let deletedCount = 0;

      for (const backupId of backupIds) {
        if (await this.deleteProformaSlipBackup(backupId)) {
          deletedCount++;
        }
      }

      return deletedCount;
    } catch (error) {
      console.error(`Error deleting multiple proforma slip backups:`, error);
      return 0;
    }
  }

  // These methods are properly implemented earlier
  // No duplicate implementation needed

  async runBackupOperation(): Promise<{
    scansBackedUp: number,
    loadingOpsBackedUp: number,
    proformaSlipsBackedUp: number
  }> {
    let scansBackedUp = 0;
    let loadingOpsBackedUp = 0;
    let proformaSlipsBackedUp = 0;

    // Backup scan history records that haven't been backed up yet
    const scanHistoryToBackup = Array.from(this.scans.values())
      .filter(scan => !scan.isBackedUp);

    for (const scan of scanHistoryToBackup) {
      await this.backupScanHistory(scan.id);
      scansBackedUp++;
    }

    // Backup loading operations that haven't been backed up yet
    const loadingOpsToBackup = Array.from(this.loadingOps.values())
      .filter(op => !op.isBackedUp);

    for (const op of loadingOpsToBackup) {
      await this.backupLoadingOperation(op.id);
      loadingOpsBackedUp++;
    }


    // Backup proforma slips that haven't been backed up yet
    const proformaSlipsToBackup = Array.from(this.proformaSlips.values())
      .filter(slip => !slip.isBackedUp);

    for (const slip of proformaSlipsToBackup) {
      await this.backupProformaSlip(slip.id);
      proformaSlipsBackedUp++;
    }

    // Update the last backup date in settings
    const settings = await this.getBackupSettings();
    if (settings) {
      await this.updateBackupSettings(settings.id, {
        lastBackupDate: new Date()
      });
    }

    // Apply data retention policies after backup
    await this.applyDataRetentionPolicies();

    return {
      scansBackedUp,
      loadingOpsBackedUp,
      proformaSlipsBackedUp
    };
  }

  /**
   * Apply data retention policies:
   * - Keep scan history, sales data, and proforma slips indefinitely
   * - Delete loading operations data older than 6 months
   */
  async applyDataRetentionPolicies(): Promise<{
    loadingOpsDeleted: number
  }> {
    let loadingOpsDeleted = 0;

    // Calculate date 6 months ago
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    // Find loading operation backups older than 6 months
    const oldLoadingOpBackups = Array.from(this.loadingOpBackups.values())
      .filter(backup => {
        // Skip records without backup date
        if (!backup.backupDate) return false;

        const backupDate = backup.backupDate instanceof Date 
          ? backup.backupDate 
          : new Date(backup.backupDate);

        return backupDate < sixMonthsAgo;
      });

    // Delete old loading operation backups
    for (const backup of oldLoadingOpBackups) {
      this.loadingOpBackups.delete(backup.id);
      loadingOpsDeleted++;
    }

    // Persist changes if any records were deleted
    if (loadingOpsDeleted > 0) {
      await this.persistLoadingOpBackups();
      console.log(`Deleted ${loadingOpsDeleted} loading operations older than 6 months`);
    }

    return {
      loadingOpsDeleted
    };
  }

  // Message operations
  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const id = this.messageId++;
    const now = new Date();

    // Convert undefined values to null
    const processedMessage = Object.fromEntries(
      Object.entries(insertMessage).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const message: Message = {
      ...processedMessage as any,
      id,
      createdAt: now,
    };

    this.messages.set(id, message);

    // Persist to storage
    await this.persistMessages();

    return message;
  }

  async getMessage(id: number): Promise<Message | undefined> {
    return this.messages.get(id);
  }

  async updateMessage(id: number, messageUpdate: Partial<InsertMessage>): Promise<Message | undefined> {
    const existingMessage = this.messages.get(id);
    if (!existingMessage) return undefined;

    // Convert undefined values to null
    const processedUpdate = Object.fromEntries(
      Object.entries(messageUpdate).map(([key, value]) => [key, value === undefined ? null : value])
    );

    const updatedMessage = {
      ...existingMessage,
      ...processedUpdate,
    };

    this.messages.set(id, updatedMessage);

    // Persist to storage
    await this.persistMessages();

    return updatedMessage;
  }

  async deleteMessage(id: number): Promise<boolean> {
    const result = this.messages.delete(id);

    // Persist to storage if deletion was successful
    if (result) {
      await this.persistMessages();
    }

    return result;
  }

  async listMessages(limit = 10, offset = 0): Promise<Message[]> {
    return Array.from(this.messages.values())
      .sort((a, b) => {
        // Handle dates that might be strings when loaded from storage
        const dateA = a.createdAt instanceof Date ? a.createdAt : a.createdAt ? new Date(a.createdAt) : null;
        const dateB = b.createdAt instanceof Date ? b.createdAt : b.createdAt ? new Date(b.createdAt) : null;

        return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
      })
      .slice(offset, offset + limit);
  }

  async getMessagesForUser(userCode: string, limit = 10, offset = 0): Promise<Message[]> {
    // Find user by userCode
    const user = Array.from(this.users.values()).find(u => u.userCode === userCode);
    
    return Array.from(this.messages.values())
      .filter(message => 
        // Messages directly for this user
        message.recipientCode === userCode || 
        // Broadcast messages to all
        message.broadcastToAll === true ||
        // Messages for the user's department
        (message.broadcastToDepartment && user?.department === message.broadcastToDepartment) ||
        // Messages for the user's designation
        (message.broadcastToDesignation && user?.designation === message.broadcastToDesignation)
      )
      .sort((a, b) => {
        // Handle dates that might be strings when loaded from storage
        const dateA = a.createdAt instanceof Date ? a.createdAt : a.createdAt ? new Date(a.createdAt) : null;
        const dateB = b.createdAt instanceof Date ? b.createdAt : b.createdAt ? new Date(b.createdAt) : null;

        return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
      })
      .slice(offset, offset + limit);
  }

  async getConversation(user1Code: string, user2Code: string, limit = 20, offset = 0): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter(message => 
        // Messages between these two users in either direction
        (message.senderCode === user1Code && message.recipientCode === user2Code) ||
        (message.senderCode === user2Code && message.recipientCode === user1Code)
      )
      .sort((a, b) => {
        // Handle dates that might be strings when loaded from storage
        const dateA = a.createdAt instanceof Date ? a.createdAt : a.createdAt ? new Date(a.createdAt) : null;
        const dateB = b.createdAt instanceof Date ? b.createdAt : b.createdAt ? new Date(b.createdAt) : null;

        return (dateA?.getTime() || 0) - (dateB?.getTime() || 0); // Ascending order for conversations
      })
      .slice(offset, offset + limit);
  }

  async markMessageAsRead(id: number): Promise<Message | undefined> {
    const message = this.messages.get(id);
    if (!message) return undefined;

    const updatedMessage = {
      ...message,
      isRead: true
    };

    this.messages.set(id, updatedMessage);

    // Persist to storage
    await this.persistMessages();

    return updatedMessage;
  }

  async getUnreadMessageCount(userCode: string): Promise<number> {
    // Find user by userCode
    const user = Array.from(this.users.values()).find(u => u.userCode === userCode);
    
    return Array.from(this.messages.values())
      .filter(message => 
        // Count unread messages directly for this user
        !message.isRead && 
        (message.recipientCode === userCode || 
         // Or broadcast messages
         message.broadcastToAll === true ||
         // Messages for the user's department
         (message.broadcastToDepartment && user?.department === message.broadcastToDepartment) ||
         // Messages for the user's designation
         (message.broadcastToDesignation && user?.designation === message.broadcastToDesignation))
      )
      .length;
  }
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
      errorLog: (err: Error) => {
        // Only log unexpected errors (not relation already exists)
        if (!err.message.includes('already exists') && !err.message.includes('session_pkey')) {
          console.error('Session store error:', err.message);
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

  async getProductByBarcode(barcode: string): Promise<Product | undefined> {
    const result = await db.select().from(products).where(eq(products.barcode, barcode)).limit(1);
    return result.length ? result[0] : undefined;
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

    const result = await db.insert(products).values(productData as InsertProduct).returning();
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
    const result = await db.update(products).set(updateData).where(eq(products.id, id)).returning();
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
      await db.execute(sql`UPDATE scan_history SET product_id = NULL WHERE product_id IS NOT NULL`);
      await db.execute(sql`UPDATE scan_session_items SET product_id = NULL WHERE product_id IS NOT NULL`);
      await db.execute(sql`UPDATE scan_session_extras SET product_id = NULL WHERE product_id IS NOT NULL`);
      await db.execute(sql`UPDATE scan_session_pallet_scans SET product_id = NULL WHERE product_id IS NOT NULL`);
      await db.execute(sql`UPDATE load_operations_items SET product_id = NULL WHERE product_id IS NOT NULL`);
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

  // Scan history operations
  async createScanHistory(entry: InsertScanHistory): Promise<ScanHistory> {
    const result = await db.insert(scanHistory).values(entry).returning();
    return result[0];
  }

  async getScanHistory(id: number): Promise<ScanHistory | undefined> {
    const result = await db.select().from(scanHistory).where(eq(scanHistory.id, id)).limit(1);
    return result.length ? result[0] : undefined;
  }

  async deleteScanHistory(id: number): Promise<boolean> {
    const result = await db.delete(scanHistory).where(eq(scanHistory.id, id)).returning({ id: scanHistory.id });
    return result.length > 0;
  }

  async listScanHistory(limit = 100, offset = 0): Promise<ScanHistory[]> {
    return await db.select().from(scanHistory).orderBy(desc(scanHistory.scannedAt)).limit(limit).offset(offset);
  }

  // Loading operations
  async createLoadingOperation(operation: InsertLoadingOperation): Promise<LoadingOperation> {
    // Process the operation data to ensure all fields have correct types
    const processedOperation = { ...operation };

    // Convert orderDate to proper Date object if it's a string
    if (processedOperation.orderDate && typeof processedOperation.orderDate === 'string') {
      try {
        // Create a Date object and ensure it's valid by parsing the date parts
        let dateObj: Date;

        // Try to handle various date formats (DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD)
        if (processedOperation.orderDate.includes('/') || processedOperation.orderDate.includes('-')) {
          const parts = processedOperation.orderDate.split(/[-\/]/);
          // Check if format is YYYY-MM-DD
          if (parts[0].length === 4) {
            // Assume YYYY-MM-DD format
            dateObj = new Date(processedOperation.orderDate);
          } else {
            // Assume DD/MM/YYYY or DD-MM-YYYY format
            const day = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10) - 1; // Month is 0-based in Date
            const year = parseInt(parts[2], 10);
            dateObj = new Date(year, month, day);
          }
        } else {
          // Default - just try to parse as is
          dateObj = new Date(processedOperation.orderDate);
        }

        // Validate the date is valid
        if (isNaN(dateObj.getTime())) {
          throw new Error(`Invalid date: ${processedOperation.orderDate}`);
        }

        processedOperation.orderDate = dateObj;
        console.log(`Converted orderDate string to Date object: ${processedOperation.orderDate}`);
      } catch (error) {
        console.error(`Failed to convert orderDate string to Date: ${processedOperation.orderDate}`, error);
        // Set to null if conversion fails
        processedOperation.orderDate = null;
      }
    }

    try {
      // Get the maximum ID and add a large increment to avoid conflicts
      const maxIdResult = await db.select({ maxId: sql`MAX(id)` }).from(loadingOperations);
      const maxId = maxIdResult[0]?.maxId || 0;
      
      // Start at 1000 if no operations exist, otherwise add 1000 to the max ID
      const nextId = Math.max(1000, Number(maxId) + 1000);
      
      console.log(`Using safe ID (well above existing IDs) for loading operation: ${nextId}`);

      // Use insert method instead of raw SQL to avoid syntax issues
      const result = await db.insert(loadingOperations).values({
        id: nextId,
        status: processedOperation.status || 'LOADING',
        referenceNumber: processedOperation.referenceNumber,
        partyName: processedOperation.partyName,
        plant: processedOperation.plant || null,
        vehicleNumber: processedOperation.vehicleNumber,
        driverName: processedOperation.driverName || null, // Include driver name from proforma slip
        createdById: processedOperation.createdById,
        notes: processedOperation.notes,
        orderDate: processedOperation.orderDate,
        isBackedUp: processedOperation.isBackedUp || false,
        createdAt: new Date()
      }).returning();
      
      // Parse the result - drizzle returns the rows directly, not in a rows property
      if (result && result.length > 0) {
        return result[0] as LoadingOperation;
      } else {
        throw new Error("Failed to create loading operation: No rows returned");
      }
    } catch (error) {
      console.error("Error creating loading operation with custom ID:", error);
      throw error;
    }
  }

  async getLoadingOperation(id: number): Promise<LoadingOperation | undefined> {
    const result = await db.select({
      id: loadingOperations.id,
      status: loadingOperations.status,
      referenceNumber: loadingOperations.referenceNumber,
      partyName: loadingOperations.partyName,
      plant: loadingOperations.plant,
      vehicleNumber: loadingOperations.vehicleNumber,
      driverName: loadingOperations.driverName, // Include driver name field
      createdByCode: loadingOperations.createdByCode,
      createdAt: loadingOperations.createdAt,
      completedAt: loadingOperations.completedAt,
      notes: loadingOperations.notes,
      orderDate: loadingOperations.orderDate,
      isBackedUp: loadingOperations.isBackedUp,
      // Include user details
      creatorName: users.name,
      creatorUsername: users.username,
      creatorRole: users.role
    })
    .from(loadingOperations)
    .leftJoin(users, eq(loadingOperations.createdByCode, users.userCode))
    .where(eq(loadingOperations.id, id))
    .limit(1);
    
    if (result.length) {
      return {
        id: result[0].id,
        status: result[0].status,
        referenceNumber: result[0].referenceNumber,
        partyName: result[0].partyName,
        plant: result[0].plant,
        vehicleNumber: result[0].vehicleNumber,
        driverName: result[0].driverName, // Include driver name in return
        createdByCode: result[0].createdByCode,
        createdAt: result[0].createdAt,
        completedAt: result[0].completedAt,
        notes: result[0].notes,
        orderDate: result[0].orderDate,
        isBackedUp: result[0].isBackedUp,
        creatorName: result[0].creatorName,
        creatorUsername: result[0].creatorUsername,
        creatorRole: result[0].creatorRole
      };
    }
    
    return undefined;
  }

  async getLoadingOperationByReferenceNumber(referenceNumber: string): Promise<LoadingOperation | undefined> {
    const result = await db.select({
      id: loadingOperations.id,
      status: loadingOperations.status,
      referenceNumber: loadingOperations.referenceNumber,
      partyName: loadingOperations.partyName,
      plant: loadingOperations.plant,
      vehicleNumber: loadingOperations.vehicleNumber,
      driverName: loadingOperations.driverName, // Include driver name field
      createdByCode: loadingOperations.createdByCode,
      createdAt: loadingOperations.createdAt,
      completedAt: loadingOperations.completedAt,
      notes: loadingOperations.notes,
      orderDate: loadingOperations.orderDate,
      isBackedUp: loadingOperations.isBackedUp,
      // Include user details
      creatorName: users.name,
      creatorUsername: users.username,
      creatorRole: users.role
    })
    .from(loadingOperations)
    .leftJoin(users, eq(loadingOperations.createdByCode, users.userCode))
    .where(eq(loadingOperations.referenceNumber, referenceNumber))
    .limit(1);
    
    if (result.length) {
      return {
        id: result[0].id,
        status: result[0].status,
        referenceNumber: result[0].referenceNumber,
        partyName: result[0].partyName,
        plant: result[0].plant,
        vehicleNumber: result[0].vehicleNumber,
        driverName: result[0].driverName, // Include driver name in return
        createdByCode: result[0].createdByCode,
        createdAt: result[0].createdAt,
        completedAt: result[0].completedAt,
        notes: result[0].notes,
        orderDate: result[0].orderDate,
        isBackedUp: result[0].isBackedUp,
        creatorName: result[0].creatorName,
        creatorUsername: result[0].creatorUsername,
        creatorRole: result[0].creatorRole
      };
    }
    
    return undefined;
  }

  async updateLoadingOperation(id: number, operation: Partial<InsertLoadingOperation>): Promise<LoadingOperation | undefined> {
    try {
      // Validate that the operation ID exists before updating
      const existingOp = await this.getLoadingOperation(id);
      if (!existingOp) {
        console.log(`Loading operation with ID ${id} not found, cannot update`);
        return undefined;
      }
      
      // Process the operation data to ensure all fields have correct types
      const processedOperation = { ...operation };

      // Convert orderDate to proper Date object if it's a string
      if (processedOperation.orderDate && typeof processedOperation.orderDate === 'string') {
        try {
          // Create a Date object and ensure it's valid by parsing the date parts
          let dateObj: Date;

          // Try to handle various date formats (DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD)
          if (processedOperation.orderDate.includes('/') || processedOperation.orderDate.includes('-')) {
            const parts = processedOperation.orderDate.split(/[-\/]/);
            // Check if format is YYYY-MM-DD
            if (parts[0].length === 4) {
              // Assume YYYY-MM-DD format
              dateObj = new Date(processedOperation.orderDate);
            } else {
              // Assume DD/MM/YYYY or DD-MM-YYYY format
              const day = parseInt(parts[0], 10);
              const month = parseInt(parts[1], 10) - 1; // Month is 0-based in Date
              const year = parseInt(parts[2], 10);
              dateObj = new Date(year, month, day);
            }
          } else {
            // Default - just try to parse as is
            dateObj = new Date(processedOperation.orderDate);
          }

          // Validate the date is valid
          if (isNaN(dateObj.getTime())) {
            throw new Error(`Invalid date: ${processedOperation.orderDate}`);
          }

          processedOperation.orderDate = dateObj;
          console.log(`Converted orderDate string to Date object in update: ${processedOperation.orderDate}`);
        } catch (error) {
          console.error(`Failed to convert orderDate string to Date in update: ${processedOperation.orderDate}`, error);
          // Set to null if conversion fails
          processedOperation.orderDate = null;
        }
      }

      console.log(`Updating loading operation ${id} with data:`, JSON.stringify(processedOperation));
      const result = await db.update(loadingOperations)
        .set(processedOperation)
        .where(eq(loadingOperations.id, id))
        .returning();
      
      if (!result.length) {
        console.error(`Failed to update loading operation ${id}: No rows returned`);
        return undefined;
      }
      
      console.log(`Successfully updated loading operation ${id}`);
      return result[0];
    } catch (error) {
      console.error(`Error updating loading operation ${id}:`, error);
      throw new Error(`Failed to update loading operation: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deleteLoadingOperation(id: number): Promise<boolean> {
    try {
      // First delete all associated items to avoid foreign key constraint violations
      await db.delete(loadingOpItems).where(eq(loadingOpItems.loadOperationsId, id));
      
      // Then delete the load operation itself
      const result = await db.delete(loadingOperations).where(eq(loadingOperations.id, id)).returning({ id: loadingOperations.id });
      return result.length > 0;
    } catch (error) {
      console.error(`Error deleting loading operation ${id}:`, error);
      throw new Error(`Failed to delete loading operation: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async listLoadingOperations(limit = 100, offset = 0, startDate?: Date, endDate?: Date, orderDate?: Date): Promise<LoadingOperation[]> {
    // Base query with user information
    const baseQuery = db.select({
      id: loadingOperations.id,
      status: loadingOperations.status,
      referenceNumber: loadingOperations.referenceNumber,
      partyName: loadingOperations.partyName,
      plant: loadingOperations.plant,
      vehicleNumber: loadingOperations.vehicleNumber,
      driverName: loadingOperations.driverName, // Include driver name in query
      createdByCode: loadingOperations.createdByCode,
      createdAt: loadingOperations.createdAt,
      completedAt: loadingOperations.completedAt,
      notes: loadingOperations.notes,
      orderDate: loadingOperations.orderDate,
      isBackedUp: loadingOperations.isBackedUp,
      // Include user details
      creatorName: users.name,
      creatorUsername: users.username,
      creatorRole: users.role
    })
    .from(loadingOperations)
    .leftJoin(users, eq(loadingOperations.createdByCode, users.userCode));

    // If exact order date is provided, use it for filtering
    if (orderDate) {
      // Create start and end of the specified day
      const startOfDay = new Date(orderDate);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(orderDate);
      endOfDay.setHours(23, 59, 59, 999);

      const result = await baseQuery
        .where(
          and(
            gte(loadingOperations.orderDate, startOfDay),
            lte(loadingOperations.orderDate, endOfDay)
          )
        )
        .orderBy(desc(loadingOperations.createdAt))
        .limit(limit)
        .offset(offset);
      
      // Convert the result to the LoadingOperation type
      return result.map(op => ({
        id: op.id,
        status: op.status,
        referenceNumber: op.referenceNumber,
        partyName: op.partyName,
        vehicleNumber: op.vehicleNumber,
        driverName: op.driverName, // Include driver name in return
        createdByCode: op.createdByCode,
        createdAt: op.createdAt,
        completedAt: op.completedAt,
        notes: op.notes,
        orderDate: op.orderDate,
        isBackedUp: op.isBackedUp,
        plant: op.plant,
        creatorName: op.creatorName,
        creatorUsername: op.creatorUsername,
        creatorRole: op.creatorRole
      }));
    }

    // If date range is provided, filter by created date
    if (startDate && endDate) {
      const result = await baseQuery
        .where(
          and(
            gte(loadingOperations.createdAt, startDate),
            lte(loadingOperations.createdAt, endDate)
          )
        )
        .orderBy(desc(loadingOperations.createdAt))
        .limit(limit)
        .offset(offset);
      
      // Convert the result to the LoadingOperation type
      return result.map(op => ({
        id: op.id,
        status: op.status,
        referenceNumber: op.referenceNumber,
        partyName: op.partyName,
        vehicleNumber: op.vehicleNumber,
        driverName: op.driverName, // Include driver name in return
        createdByCode: op.createdByCode,
        createdAt: op.createdAt,
        completedAt: op.completedAt,
        notes: op.notes,
        orderDate: op.orderDate,
        isBackedUp: op.isBackedUp,
        plant: op.plant,
        creatorName: op.creatorName,
        creatorUsername: op.creatorUsername,
        creatorRole: op.creatorRole
      }));
    }

    // Otherwise return all operations
    const result = await baseQuery
      .orderBy(desc(loadingOperations.createdAt))
      .limit(limit)
      .offset(offset);
    
    // Convert the result to the LoadingOperation type
    return result.map(op => ({
      id: op.id,
      status: op.status,
      referenceNumber: op.referenceNumber,
      partyName: op.partyName,
      plant: op.plant,
      vehicleNumber: op.vehicleNumber,
      driverName: op.driverName, // Include driver name in return
      createdById: op.createdById,
      createdAt: op.createdAt,
      completedAt: op.completedAt,
      notes: op.notes,
      orderDate: op.orderDate,
      isBackedUp: op.isBackedUp,
      creatorName: op.creatorName,
      creatorUsername: op.creatorUsername,
      creatorRole: op.creatorRole
    }));
  }

  async countLoadingOperationsByStatus(status: string, orderDate?: Date): Promise<number> {
    // If exact order date is provided, use it for filtering
    if (orderDate) {
      // Create start and end of the specified day
      const startOfDay = new Date(orderDate);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(orderDate);
      endOfDay.setHours(23, 59, 59, 999);

      const result = await db.select({ count: sql<number>`count(*)` })
        .from(loadingOperations)
        .where(
          and(
eq(loadingOperations.status, status),
            gte(loadingOperations.orderDate, startOfDay),
            lte(loadingOperations.orderDate, endOfDay)
          )
        );
      return result[0]?.count || 0;
    }

    // Without date filter, just count by status
    const result = await db.select({ count: sql<number>`count(*)` })
      .from(loadingOperations)      .where(eq(loadingOperations.status, status));
    return result[0]?.count || 0;
  }

  async getLoadingOperationItems(loadingOperationId: number): Promise<LoadingOpItem[]> {
    try {
      console.log(`Fetching load operation items for loadingOperationId: ${loadingOperationId}`);
      
      // Import the cache utility for improved performance
      const { itemsCache } = await import('./utils/cache');
      
      // Use a cache key based on the loading operation ID
      const cacheKey = `load-op-items-${loadingOperationId}`;
      
      // Try to get from cache first (TTL: 30 seconds)
      const cachedItems = itemsCache.get<LoadingOpItem[]>(cacheKey);
      if (cachedItems) {
        console.log(`Using ${cachedItems.length} cached items for loading operation ID ${loadingOperationId}`);
        return cachedItems;
      }
      
      // Check if the loading operation exists using a faster query
      // This avoids fetching all fields when we just need to check existence
      const operationExists = await db.select({ id: loadingOperations.id })
        .from(loadingOperations)
        .where(eq(loadingOperations.id, loadingOperationId))
        .limit(1);
      
      if (!operationExists || operationExists.length === 0) {
        console.log(`Loading operation with ID ${loadingOperationId} not found`);
        return [];
      }
      
      // Use an optimized query with fewer columns for better performance
      // Skip returning the snake_case versions which are redundant
      const query = sql`
        SELECT 
          id, 
          load_operations_id as "loadOperationsId", 
          product_id as "productId", 
          quantity, 
          COALESCE(original_quantity, quantity) as "originalQuantity", 
          COALESCE(extra_quantity, 0) as "extraQuantity", 
          COALESCE(loaded_quantity, CASE WHEN loaded THEN quantity ELSE 0 END) as "loadedQuantity",
          loaded, 
          created_at as "createdAt", 
          sr_no as "srNo", 
          barcode, 
          item_name as "itemName", 
          sr_no_display as "srNoDisplay"
        FROM load_operations_items 
        WHERE load_operations_id = ${loadingOperationId}
        ORDER BY id ASC
      `;
      
      // Execute with a timeout to prevent long-running queries
      const startTime = Date.now();
      const result = await db.execute(query);
      const queryTime = Date.now() - startTime;
      
      if (queryTime > 500) {
        console.warn(`Slow query warning: Loading operation items query took ${queryTime}ms`);
      }
      
      const items = result.rows as LoadingOpItem[];
      
      // Process items in batches for better performance with large datasets
      const batchSize = 100;
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        
        // Process this batch
        batch.forEach(item => {
          // Ensure proper boolean value for loaded property
          if (typeof item.loaded !== 'boolean') {
            item.loaded = !!item.loaded;
          }
          
          // Fill in missing originalQuantity with quantity value if it's undefined
          if (item.originalQuantity === undefined || item.originalQuantity === null) {
            item.originalQuantity = item.quantity;
          }
          
          // Initialize extraQuantity if undefined
          if (item.extraQuantity === undefined || item.extraQuantity === null) {
            item.extraQuantity = 0;
          }
          
          // Initialize loadedQuantity if undefined
          if (item.loadedQuantity === undefined || item.loadedQuantity === null) {
            item.loadedQuantity = item.loaded ? item.quantity : 0;
          }
        });
      }
      
      console.log(`Found ${items.length} items for loading operation ID ${loadingOperationId}`);
      
      // Log only a sample of items to reduce console spam
      const sampleSize = Math.min(items.length, 10);
      for (let i = 0; i < sampleSize; i++) {
        const item = items[i];
        console.log(`Item ${item.id}: loaded=${item.loaded} (type: ${typeof item.loaded}), loadedQuantity=${item.loadedQuantity}`);
      }
      
      if (items.length > sampleSize) {
        console.log(`... and ${items.length - sampleSize} more items`);
      }
      
      console.log(`Processed ${items.length} items, ensuring loaded property is a proper boolean`);
      
      // Cache the items for future requests
      itemsCache.set(cacheKey, items, 30); // 30 seconds TTL
      
      return items;
    } catch (error) {
      console.error(`Error fetching load operation items for load operation ID ${loadingOperationId}:`, error);
      return [];
    }
  }
  
  // Keep backwards compatibility with old method name
  // Legacy method renamed to match new naming convention
  async getGJOperationItems(loadingOperationId: number): Promise<LoadingOpItem[]> {
    return this.getLoadingOperationItems(loadingOperationId);
  }
  
  // Add a new item to a loading operation
  async createLoadingOperationItem(item: InsertLoadingOpItem): Promise<LoadingOpItem> {
    try {
      const result = await db.insert(loadingOpItems).values(item).returning();
      return result[0];
    } catch (error) {
      console.error(`Error creating loading operation item:`, error);
      throw error;
    }
  }
  
  // Get a specific loading operation item by ID
  async getLoadingOperationItem(id: number): Promise<LoadingOpItem | null> {
    try {
      // Use the same SQL query format as getLoadingOperationItems for consistency
      const query = sql`
        SELECT 
          id, 
          load_operations_id as "loadOperationsId", 
          product_id as "productId", 
          quantity, 
          COALESCE(original_quantity, quantity) as "originalQuantity", 
          COALESCE(extra_quantity, 0) as "extraQuantity", 
          COALESCE(loaded_quantity, CASE WHEN loaded THEN quantity ELSE 0 END) as "loadedQuantity",
          loaded, 
          created_at as "createdAt", 
          sr_no as "srNo", 
          barcode, 
          item_name as "itemName", 
          sr_no_display as "srNoDisplay",
          -- Also include the snake_case versions for compatibility
          load_operations_id,
          product_id,
          original_quantity,
          extra_quantity,
          loaded_quantity,
          created_at,
          sr_no,
          item_name,
          sr_no_display
        FROM load_operations_items 
        WHERE id = ${id}
      `;
      
      const result = await db.execute(query);
      const item = result.rows.length > 0 ? result.rows[0] as LoadingOpItem : null;
      
      if (item) {
        // Double check normalization of values
        // Fill in missing originalQuantity with quantity value if it's undefined
        if (item.originalQuantity === undefined || item.originalQuantity === null) {
          item.originalQuantity = item.quantity;
          console.log(`Setting originalQuantity=${item.quantity} for item ${id}`);
        }
        
        // Initialize extraQuantity if undefined
        if (item.extraQuantity === undefined || item.extraQuantity === null) {
          item.extraQuantity = 0;
          console.log(`Setting extraQuantity=0 for item ${id}`);
        }
        
        // Initialize loadedQuantity if undefined
        if (item.loadedQuantity === undefined || item.loadedQuantity === null) {
          item.loadedQuantity = item.loaded ? item.quantity : 0;
          console.log(`Setting loadedQuantity=${item.loadedQuantity} for item ${id}`);
        }
        
        // Debug log
        console.log(`Item ${id}: quantity=${item.quantity}, originalQuantity=${item.originalQuantity}, extraQuantity=${item.extraQuantity}, loadedQuantity=${item.loadedQuantity}, loaded=${item.loaded}`);
      }
      
      return item || null;
    } catch (error) {
      console.error(`Error fetching loading operation item ${id}:`, error);
      return null;
    }
  }
  
  // Delete a loading operation item by ID
  async deleteLoadingOperationItem(id: number): Promise<boolean> {
    try {
      console.log(`Deleting loading operation item with ID ${id}`);
      
      // Delete the item from the database
      const result = await db.delete(loadingOpItems)
        .where(eq(loadingOpItems.id, id))
        .returning({ id: loadingOpItems.id });
      
      // Return true if at least one row was deleted
      const success = result.length > 0;
      console.log(`Deletion of loading operation item ${id} ${success ? 'succeeded' : 'failed'}`);
      
      return success;
    } catch (error) {
      console.error(`Error deleting loading operation item with ID ${id}:`, error);
      return false;
    }
  }
  
  // Update a specific loading operation item
  async updateLoadingOperationItem(id: number, data: Partial<InsertLoadingOpItem>): Promise<LoadingOpItem | null> {
    try {
      // Log the original update data
      console.log(`Original loading operation item ${id} update data:`, JSON.stringify(data));
      
      // Create a new object to hold the update data with proper type conversion
      const updateData: Record<string, any> = {};
      
      // Process each field with special handling for loaded status and quantities
      Object.entries(data).forEach(([key, value]) => {
        if (key === 'loaded') {
          // Convert loaded status to proper boolean (handles string 'true'/'false' values)
          updateData[key] = value === true || value === 'true';
          console.log(`Converting loaded status for item ${id}: ${value} -> ${updateData[key]}`);
        } else if (key === 'quantity' || key === 'loadedQuantity' || key === 'originalQuantity' || key === 'extraQuantity') {
          // Convert any string values to numbers
          const numericValue = typeof value === 'string' ? parseInt(value, 10) : value;
          updateData[key] = !isNaN(numericValue) ? numericValue : 0;
          console.log(`Setting ${key} for item ${id} to ${updateData[key]}`);
          
          // For loadedQuantity, preserve the value regardless of loaded status
          // This allows the UI to show the count of items selected for loading
          // even if they're not currently marked as loaded
          if (key === 'loadedQuantity') {
            // Always preserve the loadedQuantity value regardless of loaded status
            console.log(`Preserving loadedQuantity=${value} for item ${id} regardless of loaded status`);
          }
        } else {
          // For all other fields, copy as-is
          updateData[key] = value;
        }
      });
      
      // Get current item to update quantities properly
      const currentItem = await this.getLoadingOperationItem(id);
      
      if (!currentItem) {
        console.error(`Cannot update item ${id} - no existing item found`);
        return null;
      }
      
      // IMPORTANT: Calculate the total quantity based on original + extra
      // This ensures we display the correct expected quantity in the UI regardless of loaded status
      let originalQty = currentItem.originalQuantity || 0;
      let extraQty = currentItem.extraQuantity || 0;
      
      // If originalQuantity is being updated, use that value
      if ('originalQuantity' in updateData) {
        originalQty = updateData.originalQuantity;
      }
      
      // If extraQuantity is being updated, use that value
      if ('extraQuantity' in updateData) {
        extraQty = updateData.extraQuantity;
      }
      
      // Calculate total quantity as original + extra
      const newTotalQuantity = Number(originalQty) + Number(extraQty);
      updateData.quantity = newTotalQuantity;
      console.log(`Recalculating quantity=${updateData.quantity} (original=${originalQty} + extra=${extraQty}) for item ${id}`);
      
      // Handle loaded status and loadedQuantity
      const loadedStatus = 'loaded' in updateData ? updateData.loaded : currentItem.loaded;
      
      // Now set the loadedQuantity based on loaded status and total quantity
      // PRESERVE loadedQuantity regardless of loaded status
      if (!('loadedQuantity' in updateData)) {
        // If loadedQuantity is not being explicitly set, check current value first
        try {
          const item = await this.getLoadingOperationItem(id);
          if (item && item.loadedQuantity !== null && item.loadedQuantity !== undefined) {
            // Preserve the existing loadedQuantity value regardless of loaded status
            updateData.loadedQuantity = item.loadedQuantity;
            console.log(`Preserving existing loadedQuantity=${updateData.loadedQuantity} for item ${id}`);
          } else if (loadedStatus) {
            // Only for new or null items, if marked as loaded, use total quantity
            updateData.loadedQuantity = newTotalQuantity;
            console.log(`Setting initial loadedQuantity=${updateData.loadedQuantity} for loaded item ${id}`);
          } else {
            // For new items not loaded, but still capture the quantity value
            updateData.loadedQuantity = newTotalQuantity;
            console.log(`Setting initial loadedQuantity=${updateData.loadedQuantity} for not loaded item ${id}`);
          }
        } catch (err) {
          // If there's an error getting the item, default to the total quantity
          updateData.loadedQuantity = newTotalQuantity;
          console.log(`Error getting item ${id}, defaulting loadedQuantity to ${newTotalQuantity}`);
        }
      }
      
      // Log the final data being sent to the database
      console.log(`Updating loading operation item ${id} with processed data:`, JSON.stringify(updateData));
      
      // Execute the database update
      const [updatedItem] = await db.update(loadingOpItems)
        .set(updateData)
        .where(eq(loadingOpItems.id, id))
        .returning();
      
      if (!updatedItem) {
        console.error(`No loading operation item found with ID ${id}`);
        return null;
      }
      
      // Verify the update by fetching the record again
      const verifiedItem = await this.getLoadingOperationItem(id);
      
      console.log(`Successfully updated loading operation item ${id}. 
        New state: loaded=${verifiedItem?.loaded}, 
        loadedQuantity=${verifiedItem?.loadedQuantity}, 
        quantity=${verifiedItem?.quantity}`);
      
      return updatedItem;
    } catch (error) {
      console.error(`Error updating loading operation item ${id}:`, error);
      return null;
    }
  }
  
  /**
   * Optimized method to update multiple loading operation items in a single transaction
   * This is much more efficient than updating items one by one
   * 
   * @param updates Array of updates with ID and data to update
   * @returns Array of updated items
   */
  async batchUpdateLoadingOperationItems(updates: { id: number; data: Partial<InsertLoadingOpItem> }[]): Promise<LoadingOpItem[]> {
    // If no updates provided, return empty array
    if (!updates || updates.length === 0) {
      return [];
    }
    
    // Start performance measurement
    const startTime = Date.now();
    console.log(`Starting batch update of ${updates.length} loading operation items`);
    
    // Use a transaction for better performance and data integrity
    const updated: LoadingOpItem[] = [];
    let successCount = 0;
    let failCount = 0;
    
    try {
      // Start a transaction
      await db.execute('BEGIN');
      
      // Process each update in the transaction
      for (const update of updates) {
        const { id, data } = update;
        
        // Skip if no ID
        if (!id) {
          console.warn(`Skipping update with missing ID`);
          failCount++;
          continue;
        }
        
        try {
          // First, get the item to make sure it exists
          const existingItem = await this.getLoadingOperationItem(id);
          
          if (!existingItem) {
            console.log(`No loading operation item found with id ${id}`);
            failCount++;
            continue;
          }
          
          // Using drizzle's update syntax
          const updateResult = await db.update(loadingOpItems).set({
            // Set only the fields that are provided
            ...(data.loaded !== undefined && { loaded: data.loaded === true || data.loaded === 'true' }),
            ...(data.loadedQuantity !== undefined && { 
              loadedQuantity: typeof data.loadedQuantity === 'string' 
                ? parseInt(data.loadedQuantity, 10) 
                : data.loadedQuantity 
            }),
            ...(data.quantity !== undefined && { 
              quantity: typeof data.quantity === 'string' 
                ? parseInt(data.quantity, 10) 
                : data.quantity 
            }),
            ...(data.barcode !== undefined && { barcode: data.barcode }),
            ...(data.srNo !== undefined && { srNo: data.srNo }),
            ...(data.productId !== undefined && { productId: data.productId }),
            ...(data.originalQuantity !== undefined && { 
              originalQuantity: typeof data.originalQuantity === 'string' 
                ? parseInt(data.originalQuantity, 10) 
                : data.originalQuantity 
            }),
            ...(data.extraQuantity !== undefined && { 
              extraQuantity: typeof data.extraQuantity === 'string' 
                ? parseInt(data.extraQuantity, 10) 
                : data.extraQuantity 
            })
          })
          .where(eq(loadingOpItems.id, id))
          .returning();
          
          if (updateResult.length > 0) {
            updated.push(updateResult[0]);
            successCount++;
          } else {
            failCount++;
          }
        } catch (itemError) {
          failCount++;
          console.error(`Error updating item ${id} in batch:`, itemError);
          // Continue with other items in the batch
        }
      }
      
      // Commit the transaction
      await db.execute('COMMIT');
      
      // Clear cache for affected operation IDs to ensure data consistency
      const { itemsCache } = await import('./utils/cache');
      const uniqueOpIds = [...new Set(
        updates
          .map(update => update.data.loadOperationsId)
          .filter(Boolean)
      )];
      
      for (const opId of uniqueOpIds) {
        if (!opId) continue;
        const itemsCacheKey = `load-op-items-${opId}`;
        itemsCache.del(itemsCacheKey);
      }
      
      // Log performance
      const duration = Date.now() - startTime;
      const itemsPerSecond = Math.round((updates.length / duration) * 1000);
      console.log(`Batch update completed in ${duration}ms. Updated ${updated.length}/${updates.length} items (${itemsPerSecond} items/sec)`);
      
      return updated;
    } catch (error) {
      // Rollback on error
      try {
        await db.execute('ROLLBACK');
      } catch (rollbackError) {
        console.error("Error during transaction rollback:", rollbackError);
      }
      
      console.error(`Error in batch update of ${updates.length} items:`, error);
      return [];
    }
  }
  
  // Create multiple loading operation items in a batch
  async createLoadingOperationItems(items: InsertLoadingOpItem[]): Promise<LoadingOpItem[]> {
    if (!items.length) return [];

    try {
      // First, reset the sequence to ensure we don't get any ID conflicts
      // Import the resetSequence function from db.ts
      const { resetSequence } = await import('./db');
      
      // Reset the sequence with a safety margin of 10
      try {
        await resetSequence('load_operations_items', 'load_operations_items_id_seq', 10);
        console.log('Reset load_operations_items sequence successfully');
      } catch (seqError) {
        console.error('Failed to reset sequence:', seqError);
        // Continue anyway, it might still work
      }
    
      // Make sure ID field is excluded for each item to allow auto-generation
      const cleanedItems = items.map(item => {
        // First, ensure we're working with a plain object by converting if needed
        const plainItem = typeof item.toJSON === 'function' ? item.toJSON() : { ...item };
        
        // Create a new object without ANY id or ID property (case insensitive)
        const cleanedItem: any = {};
        for (const [key, value] of Object.entries(plainItem)) {
          // Skip any property that looks like an ID field
          if (key.toLowerCase() === 'id') {
            console.log(`Removing '${key}' property from load operation item`);
            continue;
          }
          cleanedItem[key] = value;
        }
        
        // Now we're using loadOperationsId in the schema, so handle any code
        // that might still be using gjOperationsId for compatibility
        if (cleanedItem.gjOperationsId && !cleanedItem.loadOperationsId) {
          cleanedItem.loadOperationsId = cleanedItem.gjOperationsId;
          // Remove the old field name
          delete cleanedItem.gjOperationsId;
        }
        
        // Initialize originalQuantity if undefined
        if (cleanedItem.originalQuantity === undefined || cleanedItem.originalQuantity === null) {
          // If originalQuantity is missing, use quantity if available, or 0
          cleanedItem.originalQuantity = plainItem.originalQuantity || 
                                      plainItem.quantity || 0;
          console.log(`Setting originalQuantity to ${cleanedItem.originalQuantity} for item with productId ${cleanedItem.productId}`);
        }
        
        // Initialize extraQuantity if undefined
        if (cleanedItem.extraQuantity === undefined || cleanedItem.extraQuantity === null) {
          cleanedItem.extraQuantity = plainItem.extraQuantity || 0;
          console.log(`Setting extraQuantity to 0 for item with productId ${cleanedItem.productId}`);
        }
        
        // Calculate quantity as the sum of originalQuantity and extraQuantity
        // This ensures quantity always shows total expected quantity regardless of loaded status
        cleanedItem.quantity = Number(cleanedItem.originalQuantity) + Number(cleanedItem.extraQuantity);
        console.log(`Setting quantity to ${cleanedItem.quantity} (original=${cleanedItem.originalQuantity} + extra=${cleanedItem.extraQuantity}) for item with productId ${cleanedItem.productId}`);
        
        // Initialize loadedQuantity if undefined
        if (cleanedItem.loadedQuantity === undefined || cleanedItem.loadedQuantity === null) {
          // Initialize loadedQuantity to match quantity regardless of loaded status
          // This allows loadedQuantity to be manipulated independently from loaded status
          cleanedItem.loadedQuantity = cleanedItem.quantity;
          console.log(`Setting loadedQuantity to ${cleanedItem.loadedQuantity} for item with productId ${cleanedItem.productId}`);
        }
        
        // Validate the item has the required fields
        if (!cleanedItem.loadOperationsId) {
          console.warn('Load operation item is missing loadOperationsId field!');
        }
        
        console.log(`Creating load operation item without ID: ${JSON.stringify(cleanedItem)}`);
        return cleanedItem;
      });
      
      // Check if we have any items after cleaning
      if (cleanedItems.length === 0) {
        console.warn('No valid load operation items to insert after cleaning');
        return [];
      }
      
      // Use a simpler approach now that we've truncated the table and reset the sequence
      console.log(`Inserting ${cleanedItems.length} load operation items using standard insert`);
      const result = await db.insert(loadingOpItems).values(cleanedItems).returning();
      console.log(`Successfully inserted ${result.length} load operation items`);
      return result;
    } catch (error) {
      console.error(`Error creating multiple loading operation items:`, error);
      
      // If standard insert fails, try raw SQL as a fallback
      try {
        console.log(`Standard insert failed, trying raw SQL insert...`);
        
        const cleanedItems = items.map(item => {
          const { id, ...rest } = item as any;
          return rest;
        });
        
        // Use a raw SQL query to insert the items without ID field
        const columns = Object.keys(cleanedItems[0])
          .filter(key => key.toLowerCase() !== 'id') // Double-check to exclude ID
          .join(', ');
        
        // Prepare value placeholders and flattened values array for parameterized query
        let placeholders = [];
        let values = [];
        let paramIdx = 1;
        
        for (const item of cleanedItems) {
          const itemPlaceholders = Object.keys(item)
            .filter(key => key.toLowerCase() !== 'id')
            .map(() => `$${paramIdx++}`)
            .join(', ');
          
          placeholders.push(`(${itemPlaceholders})`);
          
          Object.entries(item)
            .filter(([key]) => key.toLowerCase() !== 'id')
            .forEach(([_, value]) => {
              values.push(value);
            });
        }
        
        const query = `
          INSERT INTO load_operations_items (${columns})
          VALUES ${placeholders.join(', ')}
          RETURNING *;
        `;
        
        console.log(`Executing SQL: ${query.replace(/\s+/g, ' ')}`);
        console.log(`With ${values.length} parameters`);
        
        const result = await db.execute(sql.raw(query, ...values));
        console.log(`Successfully inserted ${result.rows.length} load operation items using raw SQL`);
        return result.rows as LoadingOpItem[];
      } catch (sqlError) {
        console.error(`Raw SQL insert also failed:`, sqlError);
        // Return an empty array instead of throwing, so the app can continue
        return [];
      }
    }
  }

  // Purchase operations
  async createPurchase(purchase: InsertPurchase): Promise<Purchase> {
    const result = await db.insert(purchases).values(purchase).returning();
    return result[0];
  }

  async getPurchase(id: number): Promise<Purchase | undefined> {
    const result = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
    return result.length ? result[0] : undefined;
  }

  async updatePurchase(id: number, purchase: Partial<InsertPurchase>): Promise<Purchase | undefined> {
    const result = await db.update(purchases).set(purchase).where(eq(purchases.id, id)).returning();
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
    const result = await db.insert(proformaSlips).values(slip).returning();
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
    const result = await db.update(proformaSlips).set(slip).where(eq(proformaSlips.id, id)).returning();
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

  // Backup operations - still using MemStorage for compatibility
  private backupSettings = new Map<number, BackupSettings>();
  private scanHistoryBackups = new Map<number, ScanHistoryBackup>();
  private loadingOpBackups = new Map<number, LoadingOperationBackup>();
  private proformaSlipBackups = new Map<number, ProformaSlipBackup>();
  private proformaSlipItemBackups = new Map<number, ProformaSlipItemBackup>();
  private loadingOpBackupItems = new Map<number, any[]>();

  private backupSettingsId = 1;
  private scanHistoryBackupId = 1;
  private loadingOpBackupId = 1;
  private proformaSlipBackupId = 1;
  private proformaSlipItemBackupId = 1;

  // Backup settings
  async getBackupSettings(): Promise<BackupSettings | undefined> {
    const result = await db.select().from(backupSettings).limit(1);
    return result.length ? result[0] : undefined;
  }

  async createBackupSettings(settings: InsertBackupSettings): Promise<BackupSettings> {
    // Use in-memory for backup settings
    const id = this.backupSettingsId++;
    const now = new Date();
    const newSettings: BackupSettings = {
      id,
      frequency: settings.frequency,
      lastRun: null,
      retentionPeriod: settings.retentionPeriod,
      createdAt: now,
      updatedAt: now,
    };
    this.backupSettings.set(id, newSettings);
    return newSettings;
  }

  async updateBackupSettings(id: number, settings: Partial<InsertBackupSettings>): Promise<BackupSettings | undefined> {
    const existingSettings = this.backupSettings.get(id);
    if (!existingSettings) return undefined;

    const updatedSettings = {
      ...existingSettings,
      ...settings,
      updatedAt: new Date()
    };

    this.backupSettings.set(id, updatedSettings);
    return updatedSettings;
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

  async updateMessage(id: number, message: Partial<InsertMessage>): Promise<Message | undefined> {
    const result = await db.update(messages)
      .set({
        ...message,
        updatedAt: new Date()
      })
      .where(eq(messages.id, id))
      .returning();
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

  // Following methods are implemented using in-memory storage for compatibility
  // These can be migrated to database tables in the future if needed

  async backupScanHistory(scanHistoryId: number): Promise<ScanHistoryBackup> {
    const id = this.scanHistoryBackupId++;
    const now = new Date();
    const backup: ScanHistoryBackup = {
      id,
      scanHistoryId,
      details: JSON.stringify({}),
      createdAt: now,
      updatedAt: now,
    };
    this.scanHistoryBackups.set(id, backup);
    return backup;
  }

  async backupLoadingOperation(loadingOperationId: number): Promise<LoadingOperationBackup> {
    const id = this.loadingOpBackupId++;
    const now = new Date();
    const backup: LoadingOperationBackup = {
      id,
      loadingOperationId,
      details: JSON.stringify({}),
      createdAt: now,
      updatedAt: now,
    };
    this.loadingOpBackups.set(id, backup);
    return backup;
  }


  async backupProformaSlip(proformaSlipId: number): Promise<ProformaSlipBackup> {
    const id = this.proformaSlipBackupId++;
    const now = new Date();
    const backup: ProformaSlipBackup = {
      id,
      proformaSlipId,
      details: JSON.stringify({}),
      createdAt: now,
      updatedAt: now,
    };
    this.proformaSlipBackups.set(id, backup);
    return backup;
  }

  async backupProformaSlipItem(slipItemId: number, proformaSlipBackupId: number): Promise<ProformaSlipItemBackup> {
    const id = this.proformaSlipItemBackupId++;
    const now = new Date();
    const backup: ProformaSlipItemBackup = {
      id,
      slipItemId,
      proformaSlipBackupId,
      details: JSON.stringify({}),
      createdAt: now,
      updatedAt: now,
    };
    this.proformaSlipItemBackups.set(id, backup);
    return backup;
  }

  async listScanHistoryBackups(startDate?: Date, endDate?: Date, limit = 100, offset = 0): Promise<ScanHistoryBackup[]> {
    return [];
  }

  async listLoadingOperationBackups(startDate?: Date, endDate?: Date, limit = 100, offset = 0, orderDate?: Date): Promise<LoadingOperationBackup[]> {
    // Return empty array as loadingOperationsBackup table isn't defined yet
    // This prevents the 500 error when accessing backup endpoints
    return [];
  }


  async listProformaSlipBackups(startDate?: Date, endDate?: Date, limit = 100, offset = 0): Promise<ProformaSlipBackup[]> {
    return [];
  }

  async listProformaSlipItemBackups(proformaSlipBackupId: number): Promise<ProformaSlipItemBackup[]> {
    return [];
  }


  async getLoadingOperationBackupItems(backupId: number): Promise<any[]> {
    return this.loadingOpBackupItems.get(backupId) || [];
  }

  async deleteLoadingOperationBackup(backupId: number): Promise<boolean> {
    return this.loadingOpBackups.delete(backupId);
  }

  async deleteProformaSlipBackup(backupId: number): Promise<boolean> {
    return this.proformaSlipBackups.delete(backupId);
  }

  async deleteProformaSlipBackups(backupIds: number[]): Promise<number> {
    let deletedCount = 0;
    for (const id of backupIds) {
      if (this.proformaSlipBackups.delete(id)) {
        deletedCount++;
      }
    }
    return deletedCount;
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

  async applyDataRetentionPolicies(): Promise<{
    loadingOpsDeleted: number
  }> {
    return {
      loadingOpsDeleted: 0
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

  // Delete activities older than 30 days
  async deleteOldActivities(daysToKeep: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await db.delete(activities)
      .where(lt(activities.createdAt, cutoffDate.toISOString()))
      .returning();

    console.log(`Deleted ${result.length} activities older than ${daysToKeep} days (before ${cutoffDate.toISOString()})`);
    return result.length;
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

  // Stock data operations for Stock Sheets
  async listProductsForStock(filters?: {
    category?: string;
    searchQuery?: string;
  }): Promise<Array<{
    id: number;
    itemName: string;
    inStock: number;
    purchased: number;
    sold: number;
    category?: string;
  }>> {
    try {
      let query = db.select({
        id: products.id,
        itemName: products.name,
        inStock: products.inStock,
        purchased: products.purchased,
        sold: products.sold,
        category: products.category,
      }).from(products);

      const conditions = [];
      
      // Apply category filter
      if (filters?.category) {
        conditions.push(eq(products.category, filters.category));
      }

      // Apply search query filter on product name
      if (filters?.searchQuery) {
        conditions.push(like(products.name, `%${filters.searchQuery}%`));
      }

      // Combine conditions with AND
      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }

      const results = await query.orderBy(asc(products.newSr));

      return results.map(product => ({
        id: product.id,
        itemName: product.itemName,
        inStock: product.inStock || 0,
        purchased: product.purchased || 0,
        sold: product.sold || 0,
        category: product.category,
      }));
    } catch (error) {
      console.error("Error listing products for stock:", error);
      return [];
    }
  }

  async getStockDataByDate(date?: Date, category?: string, searchQuery?: string): Promise<Array<{
    id: number;
    itemName: string;
    srNo?: string;
    category?: string;
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
      }).from(products);

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
            let whereConditions = [eq(proformaSlipItems.srNo, product.newSr)];
            
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
            console.error(`Error calculating sold quantity for product ${product.newSr}:`, error);
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
            srNo: product.newSr,
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

  // Purchase Order operations
  async createPurchaseOrder(purchaseOrder: InsertPurchaseOrder): Promise<PurchaseOrder> {
    try {
      const [result] = await db.insert(purchaseOrders).values(purchaseOrder).returning();
      return result;
    } catch (error) {
      console.error("Error creating purchase order:", error);
      throw error;
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

  async getPurchaseOrderByOrderNumber(orderNumber: string): Promise<PurchaseOrder | undefined> {
    try {
      const [result] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.orderNumber, orderNumber));
      return result;
    } catch (error) {
      console.error("Error getting purchase order by order number:", error);
      return undefined;
    }
  }

  async updatePurchaseOrder(id: number, purchaseOrder: Partial<InsertPurchaseOrder>): Promise<PurchaseOrder | undefined> {
    try {
      const [result] = await db.update(purchaseOrders).set({
        ...purchaseOrder,
        updatedAt: new Date()
      }).where(eq(purchaseOrders.id, id)).returning();
      return result;
    } catch (error) {
      console.error("Error updating purchase order:", error);
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
      let query = db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt));
      
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

  async updatePurchaseOrderItem(id: number, item: Partial<InsertPurchaseOrderItem>): Promise<PurchaseOrderItem | undefined> {
    try {
      // Get the current item to track product changes
      const currentItem = await this.getPurchaseOrderItem(id);
      
      const [result] = await db.update(purchaseOrderItems).set({
        ...item,
        updatedAt: new Date()
      }).where(eq(purchaseOrderItems.id, id)).returning();
      
      // Recalculate purchased quantity for affected product(s)
      if (currentItem?.productId) {
        await this.recalculateProductPurchased(currentItem.productId);
      }
      if (result?.productId && result.productId !== currentItem?.productId) {
        await this.recalculateProductPurchased(result.productId);
      }
      
      return result;
    } catch (error) {
      console.error("Error updating purchase order item:", error);
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
      const [result] = await db.insert(purchaseOrders).values(dealerPurchaseOrder).returning();
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

  async getDealerPurchaseOrderByDate(orderDate: Date): Promise<DealerPurchaseOrder | undefined> {
    try {
      const [result] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.orderDate, orderDate));
      return result;
    } catch (error) {
      console.error("Error getting dealer purchase order by date:", error);
      return undefined;
    }
  }

  async updateDealerPurchaseOrder(id: number, dealerPurchaseOrder: Partial<InsertDealerPurchaseOrder>): Promise<DealerPurchaseOrder | undefined> {
    try {
      const [result] = await db.update(purchaseOrders).set({
        ...dealerPurchaseOrder,
        updatedAt: new Date()
      }).where(eq(purchaseOrders.id, id)).returning();
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
      let query = db.select().from(purchaseOrders);
      
      if (startDate && endDate) {
        query = query.where(and(
          gte(purchaseOrders.orderDate, startDate),
          lte(purchaseOrders.orderDate, endDate)
        ));
      } else if (startDate) {
        query = query.where(gte(purchaseOrders.orderDate, startDate));
      } else if (endDate) {
        query = query.where(lte(purchaseOrders.orderDate, endDate));
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

  async getDealerPurchaseOrderItemsByDealer(dealerId: number): Promise<DealerPurchaseOrderItem[]> {
    try {
      const results = await db.select().from(purchaseOrderItems)
        .where(eq(purchaseOrderItems.dealerId, dealerId))
        .orderBy(asc(purchaseOrderItems.productCode));
      return results;
    } catch (error) {
      console.error("Error getting dealer purchase order items by dealer:", error);
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
        createdById: 1 // Default to admin user, should be passed in real implementation
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
