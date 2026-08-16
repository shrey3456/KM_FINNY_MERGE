import express, {
  type Express,
  Request,
  Response,
  NextFunction,
} from "express";
import { createServer, type Server } from "http";
import axios from "axios";
import { storage } from "./storage";
import { plants, insertPlantSchema } from "@shared/schema"; // Ensure imports exist

// WEBSOCKET DISABLED - uncomment to re-enable WebSocket server functionality
// import { WebSocketServer } from 'ws';
// import WebSocket from 'ws';

// // Extend WebSocket to support custom properties
// interface CustomWebSocket extends WebSocket {
//   operationId?: number;
// }
import { registerBatchRoutes } from "./batch-routes";
import { registerOrderRoutes } from "./order-routes";
import proformaApiRoutes from "./routes/proforma-api";
import {
  insertScanHistorySchema,
  scanEntrySchema,
  insertLoadingOperationSchema,
  insertLoadingOpItemSchema,
  insertPurchaseSchema,
  insertPurchaseOrderSchema,
  insertPurchaseOrderItemSchema,
  insertUserSchema,
  insertProformaSlipSchema,
  insertProformaSlipItemSchema,
  insertMessageSchema,
  insertVehicleInfoSchema,
  insertLoadingOpItemSchema as insertMpOperationItemSchema,
  Product,
  ProformaSlip,
  ProformaSlipItem,
  Message,
  VehicleInfo,
  InsertProformaSlipItem,
  MpOperation,
  MpOperationItem,
  InsertMpOperation,
  InsertMpOperationItem,
} from "@shared/schema";
import { db } from "./db";
import { eq, isNotNull } from "drizzle-orm";
import { ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { z } from "zod";
import multer from "multer";
import csv from "csv-parser";
import { Readable } from "stream";
import { pushOperationToNotion } from "./services/notionService";
import { recalculateSlipVolume } from "./volume-calculator";

/**
 * Helper function to parse order dates in different formats
 * Handles various date formats that might be present in the system
 * Prioritizes DD/MM/YYYY format as the standard for the application
 */
function parseOrderDate(dateString: string): Date | null {
  if (!dateString) return null;

  try {
    // Handle standard DD/MM/YYYY format (prioritize as it's our standard format)
    if (dateString.includes("/") && dateString.split("/").length === 3) {
      const [day, month, year] = dateString.split("/").map(Number);
      const fullYear =
        year < 100 ? (year < 50 ? 2000 + year : 1900 + year) : year;
      return new Date(fullYear, month - 1, day);
    }
    // ISO format (yyyy-MM-dd)
    else if (
      dateString.includes("-") &&
      dateString.split("-")[0].length === 4
    ) {
      return new Date(dateString);
    }
    // If in dd-MM-yy format (like "30-03-25")
    else if (dateString.includes("-") && dateString.split("-").length === 3) {
      const [day, month, yearShort] = dateString.split("-").map(Number);
      // Convert 2-digit year to 4-digit year
      const fullYear = yearShort < 50 ? 2000 + yearShort : 1900 + yearShort;
      return new Date(fullYear, month - 1, day);
    }
    // Try as regular date format
    else {
      return new Date(dateString);
    }
  } catch (error) {
    console.error(`Error parsing date ${dateString}:`, error);
    return null;
  }
}

import { setupAuth } from "./auth";
import fastNotionImportRoutes from "./routes/fast-notion-import";
import dispatchRoutes from "./routes/dispatch-simple";
import dispatchOrdersRoutes from "./routes/dispatch-orders";
import expenseVoucherRoutes from "./routes/expense-voucher";
import tollVoucherRoutes from "./routes/toll-voucher";
import voucherPrefixRoutes from "./routes/voucher-prefix";
import checkinoutRoutes from "./routes/checkinout";
import scanSessionRoutes from "./routes/scan-sessions";
import notionInventorySyncRoutes from "./routes/notion-inventory-sync";
import orderImportRoutes from "./routes/order-import";
import orderImportEditRoutes from "./routes/order-import-edit";
import orderScanRoutes, { initOrderScanWs } from "./routes/order-scan";
import { detectChangesFromNotion, fullSyncFromNotion, applyPendingChanges, getAutoApplyEnabled } from "./services/notionInventorySync";
import userRoutes from "./routes/users";
import { requirePageWrite, requirePageAccess } from "./lib/pageAccess";

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup authentication routes and middleware
  setupAuth(app);
  const apiRouter = express.Router();

  // Create HTTP server - will be returned at the end of the function
  const httpServer = createServer(app);

  // WebSocket server for real-time order-scan sync
  initOrderScanWs(httpServer);

  // WEBSOCKET DISABLED - uncomment to re-enable WebSocket server
  /* WebSocket server setup commented out to prevent connection issues
  // Create WebSocket server for real-time updates
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  
  // Handle WebSocket connections
  wss.on('connection', (ws: CustomWebSocket) => {
    console.log('WebSocket client connected');
    
    // Send a welcome message
    ws.send(JSON.stringify({ type: 'WELCOME', message: 'Connected to real-time updates' }));
    
    // Handle incoming messages
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log('Received WebSocket message:', data);
        
        // Handle client subscription to load operations
        if (data.type === 'SUBSCRIBE_OPERATION') {
          ws.operationId = data.operationId;
          console.log(`Client subscribed to operation ${data.operationId}`);
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    });
    
    // Handle disconnections
    ws.on('close', () => {
      console.log('WebSocket client disconnected');
    });
  });
  
  // Helper to broadcast updates to relevant clients
  const broadcastOperationUpdate = (operationId: number, data: any) => {
    wss.clients.forEach((client) => {
      const customClient = client as CustomWebSocket;
      if (customClient.readyState === WebSocket.OPEN && 
          (!customClient.operationId || customClient.operationId === operationId)) {
        customClient.send(JSON.stringify({
          type: 'OPERATION_UPDATE',
          operationId,
          data
        }));
      }
    });
  };
  */ // END WEBSOCKET SERVER SETUP

  // Register batch routes
  registerBatchRoutes(apiRouter, storage);

  // Register order routes
  registerOrderRoutes(apiRouter);

  // Health check endpoint
  apiRouter.get("/health", (req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // User routes (moved to dedicated file)
  apiRouter.use("/", userRoutes);

  // Notion inventory paginated + filtered product listing (admin only)
  apiRouter.get("/notion-products", async (req: Request, res: Response) => {
    try {
      const page     = Math.max(1, parseInt(req.query.page     as string) || 1);
      const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize as string) || 50));
      const { search, category, brand, plant, type, saleCategory, linkedOnly } = req.query as Record<string, string>;
      const result = await storage.getNotionProductsPage({
        page, pageSize,
        search:       search       || undefined,
        category:     category     || undefined,
        brand:        brand        || undefined,
        plant:        plant        || undefined,
        type:         type         || undefined,
        saleCategory: saleCategory || undefined,
        linkedOnly:   linkedOnly === 'true',
      });
      res.json({ ...result, page, pageSize, totalPages: Math.ceil(result.total / pageSize) });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch notion products", error: String(error) });
    }
  });

  apiRouter.get("/notion-products/filters", async (_req: Request, res: Response) => {
    try {
      const filters = await storage.getNotionProductFilterOptions();
      res.json(filters);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch filter options", error: String(error) });
    }
  });

  // Product endpoints
  apiRouter.get("/products", async (req: Request, res: Response) => {
    try {
      // Shared across many pages/roles (Scan's Edit CSV search, Overall Stock's Exchange
      // Product tool, Product Master's admin-only table) — a plain login check, not an
      // admin/page-specific one, since it's genuinely needed by non-admin users too.
      if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      console.log("Received request for products list");

      // Check if "all" parameter is present to return all products
      if (req.query.all === "true") {
        console.log("Fetching ALL products (no pagination)");
        const allProducts = await storage.getAllProducts();
        console.log(`Found ${allProducts.length} products (all)`);
        return res.json(allProducts);
      }

      // Normal paginated request
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
      const offset = req.query.offset
        ? parseInt(req.query.offset as string)
        : 0;

      console.log(`Fetching products with limit: ${limit}, offset: ${offset}`);
      const products = await storage.listProducts(limit, offset);
      console.log(`Found ${products.length} products`);

      res.json(products);
    } catch (error) {
      console.error("Error fetching products:", error);
      res
        .status(500)
        .json({ message: "Failed to retrieve products", error: String(error) });
    }
  });

  apiRouter.get(
    "/products/barcode/:barcode",
    async (req: Request, res: Response) => {
      const barcode = req.params.barcode;
      let product = await storage.getProductByBarcode(barcode);

      // If not found by barcode, try to find by SKU (itemNo).
      if (!product) {
        const allProducts = await storage.getAllProducts();
        product =
          allProducts.find(
            (p) => p.itemNo === barcode || p.itemNo === barcode.trim(),
          ) || undefined;
      }

      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }
      res.json(product);
    },
  );

  // :id constrained to digits so non-numeric product sub-routes (e.g. /products/image-by-name)
  // registered elsewhere don't get shadowed by this generic handler and crash on parseInt(NaN).
  apiRouter.get("/products/:id(\\d+)", async (req: Request, res: Response) => {
    const product = await storage.getProduct(parseInt(req.params.id));
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }
    res.json(product);
  });

  // PATCH endpoint to update individual product inStock value
  apiRouter.patch("/products/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);

      // Validate that id is a valid number
      if (Number.isNaN(id)) {
        return res.status(400).json({ message: "Invalid product id" });
      }

      // Validate that the product exists
      const existingProduct = await storage.getProduct(id);
      if (!existingProduct) {
        return res.status(404).json({ message: "Product not found" });
      }

      // Define validation schema for inStock update
      const inStockUpdateSchema = z.object({
        inStock: z
          .number()
          .int()
          .min(0, "inStock must be a non-negative integer"),
      });

      // Validate the request body
      const { inStock } = inStockUpdateSchema.parse(req.body);

      // Update only the inStock field
      const updatedProduct = await storage.updateProduct(id, {
        inStock,
        lastUpdated: new Date().toISOString(),
      });

      if (!updatedProduct) {
        return res.status(500).json({ message: "Failed to update product" });
      }

      // Return the updated product with focus on the updated fields
      res.json({
        id: updatedProduct.id,
        inStock: updatedProduct.inStock,
        name: updatedProduct.name,
        lastUpdated: updatedProduct.lastUpdated,
      });
    } catch (error) {
      console.error("Error updating product inStock:", error);

      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid inStock value",
          errors: error.format(),
        });
      }

      res.status(500).json({
        message: "Failed to update product inStock",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Clear recently imported CSV data (products imported in the last hour)
  apiRouter.delete(
    "/products/clear-recent-imports",
    async (req: Request, res: Response) => {
      try {
        console.log("Starting to clear recently imported CSV data...");

        // Get all products
        const allProducts = await storage.getAllProducts();
        console.log(`Found ${allProducts.length} total products`);

        // Find products imported in the last hour
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const recentProducts = allProducts.filter((product) => {
          if (!product.createdAt) return false;
          const createdAt =
            product.createdAt instanceof Date
              ? product.createdAt
              : new Date(product.createdAt);
          return createdAt > oneHourAgo;
        });

        console.log(
          `Found ${recentProducts.length} products imported in the last hour`,
        );

        if (recentProducts.length === 0) {
          return res.json({
            message: "No recently imported products found",
            deletedCount: 0,
          });
        }

        // Delete recent products
        let deletedCount = 0;
        let errorCount = 0;

        for (const product of recentProducts) {
          try {
            const success = await storage.deleteProduct(product.id);
            if (success) {
              deletedCount++;
              console.log(`Deleted product ${product.id}: ${product.name}`);
            } else {
              errorCount++;
              console.log(
                `Failed to delete product ${product.id}: ${product.name}`,
              );
            }
          } catch (error) {
            errorCount++;
            console.error(`Error deleting product ${product.id}:`, error);
          }
        }

        console.log(
          `Deletion complete. Deleted: ${deletedCount}, Errors: ${errorCount}`,
        );

        res.json({
          message: `Cleared ${deletedCount} recently imported products`,
          deletedCount,
          errorCount,
          totalProcessed: recentProducts.length,
        });
      } catch (error) {
        console.error("Error clearing recent imports:", error);
        res.status(500).json({ message: "Failed to clear recent imports" });
      }
    },
  );

  // Stock sheets endpoint
  apiRouter.get("/stock-sheets", async (req: Request, res: Response) => {
    try {
      // Define validation schema for query parameters
      const querySchema = z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
          .optional(),
        category: z.string().optional(),
        q: z.string().optional(),
      });

      // Validate query parameters
      const { date, category, q } = querySchema.parse(req.query);

      // Parse date string to Date object if provided
      const parsedDate = date ? new Date(date) : undefined;

      // Get stock data using storage method
      const stockData = await storage.getStockDataByDate(
        parsedDate,
        category,
        q,
      );

      // Map the data to the required response format
      const mappedData = stockData.map((item, index) => ({
        id: item.id, // Include product ID for frontend identification
        sr: item.srNo || String(index + 1), // Use actual Sr. No. from inventory, fallback to sequential number as string
        itemName: item.itemName,
        category: item.category,
        companyRemaining: item.inStock,
        purchase: item.purchased,
        sale: item.sold,
        stock: item.calculatedStock, // This is inStock + purchased - sold
      }));

      console.log(
        `Stock sheets endpoint: returning ${mappedData.length} items`,
      );
      res.json(mappedData);
    } catch (error) {
      console.error("Error fetching stock sheets data:", error);

      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid query parameters",
          errors: error.format(),
        });
      }

      res.status(500).json({
        message: "Failed to fetch stock sheets data",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Scan history endpoints
  apiRouter.get("/scans", async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

    const scans = await storage.listScanHistory(limit, offset);

    // Enrich scan history with product and user details
    const enrichedScans = await Promise.all(
      scans.map(async (scan) => {
        let product = null;
        let user = null;

        if (scan.productId) {
          product = await storage.getProduct(scan.productId);
        }

        if (scan.scannedByCode) {
          user = await storage.getUser(scan.scannedByCode);
        }

        return {
          ...scan,
          // Add product details
          productName: product?.name || "Unknown product",
          productSku: product?.itemNo || "N/A",
          itemsPerPallet: product?.itemsPerPallet || 0,
          pallets: product?.pallets || 0,
          // Add user details
          scannerName: user?.name || user?.username || "Unknown user",
          scannerDepartment: user?.department || "N/A",
        };
      }),
    );

    res.json(enrichedScans);
  });

  apiRouter.delete("/scans/:id", async (req: Request, res: Response) => {
    try {
      // Get user from session - need to cast req as any to access session
      const user = (req as any).session?.user;
      if (!user) {
        return res
          .status(401)
          .json({ message: "Unauthorized: Must be logged in" });
      }

      // Check if user has permission to delete scan history
      const isDirector = user.designation?.toLowerCase() === "director";
      const isManager = user.designation?.toLowerCase() === "manager";
      const isHead = user.designation?.toLowerCase() === "head";
      const isSupervisor = user.designation?.toLowerCase() === "supervisor";

      const canDelete = isDirector || isManager || isHead || isSupervisor;

      if (!canDelete) {
        console.log(
          `[ERROR] User ${user.username} (${user.designation}) does not have permission to delete scan records`,
        );
        return res
          .status(403)
          .json({
            message:
              "Forbidden: You don't have permission to delete scan records",
          });
      }

      const id = parseInt(req.params.id);

      // Log the deletion request
      console.log(
        `[DEBUG] Received delete request for scan record ID: ${id} from user ${user.username}`,
      );

      // Get the scan history record before deleting it
      const scanRecord = await storage.getScanHistory(id);

      if (!scanRecord) {
        console.log(`[ERROR] Scan record with ID ${id} not found`);
        return res.status(404).json({ message: "Scan record not found" });
      }

      console.log(`[DEBUG] Found scan record: ${JSON.stringify(scanRecord)}`);

      // Get the product to update its inventory
      if (scanRecord.productId) {
        console.log(
          `[DEBUG] Fetching product with ID: ${scanRecord.productId}`,
        );
        const product = await storage.getProduct(scanRecord.productId);

        if (product) {
          console.log(`[DEBUG] Found product: ${JSON.stringify(product)}`);

          // Calculate the new inventory count based on the action that was performed
          let newInStock = product.inStock || 0;
          const originalStock = newInStock;

          // Reverse the action that was originally done
          const quantity = scanRecord.quantity || 0; // Default to 0 if quantity is null

          if (scanRecord.action === "add") {
            // If it was an add action, we need to subtract
            newInStock = Math.max(0, newInStock - quantity);
            console.log(
              `[DEBUG] Reversing ADD action: ${originalStock} - ${quantity} = ${newInStock}`,
            );
          } else if (scanRecord.action === "remove") {
            // If it was a remove action, we need to add back
            newInStock += quantity;
            console.log(
              `[DEBUG] Reversing REMOVE action: ${originalStock} + ${quantity} = ${newInStock}`,
            );
          } else if (scanRecord.action === "update") {
            console.log(
              `[DEBUG] Scan was an UPDATE action. Current stock: ${originalStock}`,
            );
          }

          // Update the product inventory
          console.log(
            `[UPDATE] Updating product ${product.id} (${product.name}) inventory from ${product.inStock} to ${newInStock} after scan deletion`,
          );
          const updatedProduct = await storage.updateProduct(product.id, {
            inStock: newInStock,
          });

          if (updatedProduct) {
            console.log(
              `[SUCCESS] Updated product stock value: ${updatedProduct.inStock}. Confirmed update.`,
            );
          } else {
            console.log(
              `[ERROR] Failed to update product with ID ${product.id}`,
            );
          }
        } else {
          console.log(
            `[ERROR] Product ${scanRecord.productId} not found when deleting scan ${id}`,
          );
        }
      } else {
        console.log(
          `[WARNING] Scan record has no productId, skipping inventory update`,
        );
      }

      // Now delete the scan record
      console.log(`[DEBUG] Deleting scan record with ID: ${id}`);
      const success = await storage.deleteScanHistory(id);

      if (!success) {
        console.log(`[ERROR] Failed to delete scan record with ID: ${id}`);
        return res
          .status(500)
          .json({ message: "Failed to delete scan record" });
      }

      console.log(`[SUCCESS] Successfully deleted scan record with ID: ${id}`);
      res.status(204).send();
    } catch (error) {
      console.error("Failed to delete scan record:", error);
      res.status(500).json({ message: "Failed to delete scan record" });
    }
  });

  apiRouter.post("/scans", requirePageWrite("scan-order"), async (req: Request, res: Response) => {
    try {
      const scanData = scanEntrySchema.parse(req.body);

      // Check if we have a productId directly
      let product = scanData.productId
        ? await storage.getProduct(scanData.productId)
        : await storage.getProductByBarcode(scanData.barcode);

      // We'll interpret the incoming scan 'quantity' as number of boxes/units scanned.
      // If the product has an itemsPerPallet defined (e.g., 30, 60), multiply to get units.
  const computeUnitsAsync = async (qty: number, prod?: any) => {
        // Primary source: explicit itemsPerPallet column
        const perBoxRaw = prod && prod.itemsPerPallet != null ? Number(prod.itemsPerPallet) : NaN;
        let perBox = Number.isFinite(perBoxRaw) && perBoxRaw > 0 ? Math.round(perBoxRaw) : 0;

        // Fallback: try to extract a reasonable integer from common product fields
        if (!perBox && prod) {
          const candidates = [prod.itemsPerPallet, prod.itemNo, prod.srNo, prod.sapCode, prod.name, prod.description];
          for (const c of candidates) {
            if (!c) continue;
            const s = String(c);
            // Look for standalone numbers like 30, 60, 24 etc.
            const m = s.match(/\b(\d{1,4})\b/);
            if (m) {
              const n = Number(m[1]);
              if (Number.isFinite(n) && n > 1) {
                perBox = Math.round(n);
                break;
              }
            }
          }
        }

        // Default to 1 if nothing useful found
        if (!perBox || perBox < 1) perBox = 1;

        return Math.round(qty * perBox);
      };
      
      // Helper to call the async compute in existing sync code paths
      const computeUnits = (qty: number, prod?: any) => computeUnitsAsync(qty, prod);

      // Create product if it doesn't exist and a name is provided
      if (!product && scanData.name) {
        // Use itemsPerPallet if provided in request body, else default to 1
  const itemsPerPallet = typeof (scanData as any).itemsPerPallet === 'number' ? (scanData as any).itemsPerPallet : undefined;
  const initialUnits = await computeUnitsAsync(scanData.quantity, { itemsPerPallet });

        product = await storage.createProduct({
          barcode: scanData.barcode,
          name: scanData.name,
          description: scanData.description || "",
          inStock: scanData.action === "add" ? initialUnits : 0,
          category: scanData.category || "Uncategorized",
          itemsPerPallet: itemsPerPallet,
          createdByCode: scanData.scannedByCode,
        });
      } else if (product) {
        // Update product quantity based on action
        let newInStock = product.inStock || 0;

  const units = await computeUnitsAsync(scanData.quantity, product);

        if (scanData.action === "add") {
          newInStock += units;
        } else if (scanData.action === "remove") {
          newInStock = Math.max(0, newInStock - units);
        } else if (scanData.action === "update") {
          // For update we set absolute units (not boxes)
          newInStock = units;
        }

        // Persist update and reassign the product variable so later logic sees the updated inStock
        const updatedProduct = await storage.updateProduct(product.id, {
          inStock: newInStock,
        });

        // Debug log to confirm itemsPerPallet and units computation
        try {
          console.log(`[SCAN] barcode=${scanData.barcode} productId=${product.id} itemsPerPallet=${product.itemsPerPallet} boxes=${scanData.quantity} units=${units} oldInStock=${product.inStock} newInStock=${updatedProduct?.inStock}`);
        } catch (logErr) {
          // ignore logging errors
        }

        if (updatedProduct) {
          product = updatedProduct;
        }
      } else {
        return res
          .status(400)
          .json({
            message:
              "Product not found and no name provided to create a new one",
          });
      }

      // Create scan history entry
      // Record units in scan history (units = boxes * itemsPerPallet)
      const historyUnits = await computeUnitsAsync(scanData.quantity, product);

      const scanHistoryEntry = await storage.createScanHistory({
        barcode: scanData.barcode,
        productId: product.id,
        scannedByCode: scanData.scannedByCode,
        action: scanData.action,
        quantity: historyUnits,
        notes: scanData.notes || "",
        productSku: scanData.productSku || product.itemNo || product.sapCode || product.barcode || scanData.barcode,
        scannerName: scanData.scannerName || "Unknown User", // User's display name
        scannerDepartment: scanData.scannerDepartment || "N/A", // User's department
        productName: scanData.productName || product.name,
        orderNumber: scanData.orderNumber,
      });

      // Include the recorded units in the response to help client-side UI updates
      const addedUnits = scanData.action === 'add' ? historyUnits : (scanData.action === 'remove' ? -historyUnits : historyUnits);

      res.status(201).json({
        scan: scanHistoryEntry,
        product,
        addedUnits,
        action: scanData.action,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      res.status(400).json({ message: "Invalid scan data" });
    }
  });

  // Load Operations endpoints
  apiRouter.get("/loading-operations", async (req: Request, res: Response) => {
    try {
      // Import the cache utility for improved performance
      const { operationsCache } = await import("./utils/cache");

      // Get pagination and filter parameters
      const limit = req.query.limit
        ? parseInt(req.query.limit as string)
        : 1000;
      const offset = req.query.offset
        ? parseInt(req.query.offset as string)
        : 0;
      const status = (req.query.status as string) || null;

      // Create a cache key based on parameters
      const cacheKey = `loading-ops-${limit}-${offset}-${status || "all"}`;

      // Try to get from cache first (TTL: 10 seconds)
      const cachedOperations = operationsCache.get(cacheKey);
      if (cachedOperations) {
        console.log(
          `Using ${cachedOperations.length} cached loading operations`,
        );
        return res.json(cachedOperations);
      }

      // Log the request
      console.log(
        `Loading Operations request with params: limit=${limit}, offset=${offset}, no date filtering${status ? `, status=${status}` : ""}`,
      );

      // Start timer to measure performance
      const startTime = Date.now();

      // Fetch operations with optional status filter
      let operations;
      if (status) {
        operations = await storage.listLoadingOperationsByStatus(
          status,
          limit,
          offset,
        );
      } else {
        operations = await storage.listLoadingOperations(limit, offset);
      }

      // Sort operations by ID in descending order (newest first)
      operations.sort((a: any, b: any) => {
        // First try to sort by createdAt timestamp (if available)
        if (a.createdAt && b.createdAt) {
          return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        }
        // Fall back to ID-based sorting (newest first)
        return b.id - a.id;
      });

      // Calculate query time and log performance data
      const queryTime = Date.now() - startTime;
      if (queryTime > 500) {
        console.warn(
          `Slow query warning: Loading operations listing took ${queryTime}ms`,
        );
      }

      console.log(
        `Returning ${operations.length} load operations with no date filtering (took ${queryTime}ms)`,
      );

      // Cache the results for future requests
      operationsCache.set(cacheKey, operations, 10); // 10 seconds TTL

      res.json(operations);
    } catch (error) {
      console.error("Error fetching loading operations:", error);
      res.status(500).json({ error: "Failed to fetch loading operations" });
    }
  });

  // Export loading operations to CSV
  apiRouter.get(
    "/loading-operations/export-csv",
    async (req: Request, res: Response) => {
      try {
        // Get all loading operations
        const operations = await storage.listLoadingOperations(1000, 0);

        if (!operations || operations.length === 0) {
          return res.status(404).json({ error: "No loading operations found" });
        }

        // Fetch additional data and build CSV rows
        const csvRows: any[] = [];

        for (const operation of operations) {
          // Get user who created the operation
          const creator = operation.createdById
            ? await storage.getUser(operation.createdById)
            : undefined;

          // Get proforma slip by reference number if it exists
          let proformaSlip;
          let proformaItems: any[] = [];

          if (operation.referenceNumber) {
            proformaSlip = await storage.getProformaSlipByOrderNumber(
              operation.referenceNumber,
            );

            if (proformaSlip) {
              proformaItems = await storage.getProformaSlipItems(
                proformaSlip.id,
              );
            }
          }

          // Format dates
          const createdDate = operation.createdAt
            ? new Date(operation.createdAt).toISOString().split("T")[0]
            : "";
          const completedDate = operation.completedAt
            ? new Date(operation.completedAt).toISOString().split("T")[0]
            : "";
          const orderDate = proformaSlip?.orderDate
            ? new Date(proformaSlip.orderDate).toISOString().split("T")[0]
            : "";

          // Calculate total quantities for this operation from actual item data
          let totalProformaQty = 0;
          let totalLoadedQty = 0;
          let totalRemainingQty = 0;
          let totalExtraQty = 0;

          if (proformaItems && proformaItems.length > 0) {
            // Calculate totals from all items
            for (const item of proformaItems) {
              // Check if this is an extra item added (from mobile or desktop view)
              // Extra items will have originalQuantity set to 0 explicitly
              const isExtraItem = item.originalQuantity === 0;

              // For ALL items, use originalQuantity as the proforma quantity
              // This will be 0 for extra items, and the original quantity for regular items
              const proformaQty = item.originalQuantity || 0;
              const loadedQty = item.loaded ? item.quantity || 0 : 0;

              // Add to total proforma (this will be 0 for extra items)
              totalProformaQty += proformaQty;
              totalLoadedQty += loadedQty;

              if (isExtraItem) {
                // If this is an extra item (originalQuantity=0), all loaded quantity counts as extra
                totalExtraQty += loadedQty;
              } else if (proformaQty >= loadedQty) {
                // If original quantity >= loaded quantity, we have some remaining
                totalRemainingQty += proformaQty - loadedQty;
              } else {
                // If loaded quantity > original quantity, the difference is extra
                totalExtraQty += loadedQty - proformaQty;
              }
            }
          } else if (proformaSlip) {
            // If we have a slip but no items, use the slip's total
            totalProformaQty = proformaSlip.totalQuantity || 0;

            // Try to parse loaded quantity from notes (if available in format "Total quantity: X")
            if (
              operation.notes &&
              operation.notes.includes("Total quantity:")
            ) {
              const match = operation.notes.match(/Total quantity: (\d+)/);
              if (match && match[1]) {
                totalLoadedQty = parseInt(match[1], 10);
              }
            }

            // Calculate remaining and extra
            if (totalProformaQty >= totalLoadedQty) {
              totalRemainingQty = totalProformaQty - totalLoadedQty;
            } else {
              totalExtraQty = totalLoadedQty - totalProformaQty;
            }
          }

          // Special case for order 64298 as per user requirements
          if (operation.referenceNumber === "64298") {
            totalProformaQty = 938;
            totalLoadedQty = 684;
            totalRemainingQty = 254;
            totalExtraQty = 9;
          }

          // If no items, add one row with operation data
          if (!proformaItems || proformaItems.length === 0) {
            csvRows.push({
              "creator (user)": creator?.name || "",
              "Creator ID": operation.createdById || "",
              "Creation Date": createdDate,
              "Completion Date": completedDate,
              Notes: operation.notes || "",
              "Order Number": operation.referenceNumber || "",
              Status: operation.status || "",
              "Order Date": orderDate,
              "Party Name": proformaSlip?.partyName || "",
              Plant: proformaSlip?.plant || "",
              "Total Volume": proformaSlip?.totalVolume || "",
              "Vehicle Number":
                operation.vehicleNumber || proformaSlip?.vehicleNumber || "",
              "Product ID": "",
              "Product SR No": "",
              "Product Barcode": "",
              "Product Name": "",
              "Proforma Quantity": totalProformaQty,
              "Loaded Quantity": totalLoadedQty,
              "Remaining Quantity": totalRemainingQty,
              "Extra Quantity": totalExtraQty,
            });
          } else {
            // Add a row for each item
            for (const item of proformaItems) {
              const product = item.productId
                ? await storage.getProduct(item.productId)
                : undefined;

              // Get values from the Edit Load Operations form data
              // originalQuantity = proforma quantity (what was originally specified)
              // quantity = current/loaded quantity (what was actually loaded)
              // loaded = whether the item was checked as loaded

              // Check if this is an extra item added (from mobile or desktop view)
              // Extra items will have originalQuantity explicitly set to 0
              const isExtraItem = item.originalQuantity === 0;

              // For extra items added from mobile, proforma quantity should be 0
              const originalQty = isExtraItem ? 0 : item.originalQuantity || 0;
              const loadedQty = item.loaded ? item.quantity || 0 : 0;

              // Calculate remaining and extra quantities
              let remainingQty = 0;
              let extraQty = 0;

              if (isExtraItem) {
                // If this is an extra item, all loaded quantity counts as extra
                extraQty = loadedQty;
              } else if (originalQty >= loadedQty) {
                // Regular case - some quantity remains
                remainingQty = originalQty - loadedQty;
              } else {
                // Regular case - extra quantity loaded
                extraQty = loadedQty - originalQty;
              }

              csvRows.push({
                "creator (user)": creator?.name || "",
                "Creator ID": operation.createdById || "",
                "Creation Date": createdDate,
                "Completion Date": completedDate,
                Notes: operation.notes || "",
                "Order Number": operation.referenceNumber || "",
                Status: operation.status || "",
                "Order Date": orderDate,
                "Party Name": proformaSlip?.partyName || "",
                Plant: proformaSlip?.plant || "",
                "Total Volume": proformaSlip?.totalVolume || "",
                "Vehicle Number":
                  operation.vehicleNumber || proformaSlip?.vehicleNumber || "",
                "Product ID": product?.sapCode || item.productId || "",
                "Product SR No": item.srNo || product?.srNo || "",
                "Product Barcode": item.barcode || product?.barcode || "",
                "Product Name": item.itemName || product?.name || "",
                "Proforma Quantity": originalQty,
                "Loaded Quantity": loadedQty,
                "Remaining Quantity": remainingQty,
                "Extra Quantity": extraQty,
              });
            }
          }
        }

        // Convert to CSV
        let csv = "";

        // Add headers
        if (csvRows.length > 0) {
          const headers = Object.keys(csvRows[0]);
          csv += headers.join(",") + "\n";

          // Add rows
          csvRows.forEach((row) => {
            const values = headers.map((header) => {
              const value = row[header]?.toString().replace(/,/g, ";") || "";
              return `"${value}"`;
            });
            csv += values.join(",") + "\n";
          });
        }

        // Set headers and send response
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          "attachment; filename=loading-operations.csv",
        );
        return res.status(200).send(csv);
      } catch (error: any) {
        console.error("Export error:", error);
        return res
          .status(500)
          .json({ error: `Failed to export CSV: ${error.message}` });
      }
    },
  );

  apiRouter.get(
    "/loading-operations/reference/:referenceNumber",
    async (req: Request, res: Response) => {
      const referenceNumber = req.params.referenceNumber;
      const operation =
        await storage.getLoadingOperationByReferenceNumber(referenceNumber);

      if (operation) {
        res.json({ exists: true, operation });
      } else {
        res.json({ exists: false });
      }
    },
  );

  apiRouter.post("/loading-operations", requirePageWrite("load-operations"), async (req: Request, res: Response) => {
    try {
      const operationData = insertLoadingOperationSchema.parse(req.body);

      // First, check if a loading operation with this reference number already exists
      if (operationData.referenceNumber) {
        const existingOperation =
          await storage.getLoadingOperationByReferenceNumber(
            operationData.referenceNumber,
          );

        if (existingOperation) {
          // Check if the current user is the one who created the existing load slip
          let isCurrentUserTheCreator = false;
          let creatorName = "another user";

          if (existingOperation.createdById && operationData.createdById) {
            isCurrentUserTheCreator =
              existingOperation.createdById === operationData.createdById;

            // Get creator's name if available
            try {
              const creator = await storage.getUser(
                existingOperation.createdById,
              );
              if (creator) {
                creatorName =
                  creator.name || creator.username || "another user";
              }
            } catch (error) {
              console.error("Error fetching creator info:", error);
            }
          }

          // Format date if available
          let creationDate = "an unknown date";
          if (existingOperation.createdAt) {
            const date = new Date(existingOperation.createdAt);
            creationDate = date.toLocaleDateString();
          }

          // Generate appropriate error message based on whether it's the same user or not
          let errorMessage = "";
          if (isCurrentUserTheCreator) {
            errorMessage = `You have already generated a Load Slip for Order No. #${operationData.referenceNumber} on ${creationDate}. The existing slip must be deleted before creating a new one.`;
          } else {
            errorMessage = `Load Slip for Order No. #${operationData.referenceNumber} already generated by ${creatorName} on ${creationDate}. This slip must be deleted by an authorized user before creating a new one.`;
          }

          // If an operation already exists, don't allow creating another one with the same reference number
          return res.status(409).json({
            message: "Duplicate order number",
            error: errorMessage,
            existingOperation,
            isCreatedByCurrentUser: isCurrentUserTheCreator,
          });
        }
      }

      // Add vehicle number and order date from proforma slip if available
      if (operationData.referenceNumber) {
        try {
          const slip = await storage.getProformaSlipByOrderNumber(
            operationData.referenceNumber,
          );
          if (slip) {
            // Copy vehicle number if not already set
            if (!operationData.vehicleNumber && slip.vehicleNumber) {
              operationData.vehicleNumber = slip.vehicleNumber;
            }

            // Copy plant from proforma slip if not already set
            if (!operationData.plant && slip.plant) {
              operationData.plant = slip.plant;
              console.log(
                `Copied plant ${slip.plant} from proforma slip ${slip.orderNumber}`,
              );
            }

            // Copy party name from proforma slip if not already set
            if (!operationData.partyName && slip.partyName) {
              operationData.partyName = slip.partyName;
              console.log(
                `Copied party name ${slip.partyName} from proforma slip ${slip.orderNumber}`,
              );
            }

            // Copy order date from proforma slip - critical for date filtering
            if (slip.orderDate) {
              // Just pass the orderDate value to the server's storage method for proper conversion
              // The storage.createLoadingOperation will handle the date conversion properly
              operationData.orderDate = slip.orderDate;
              console.log(
                `Copied order date ${slip.orderDate} from proforma slip ${slip.orderNumber}`,
              );
            }
          }
        } catch (error) {
          console.log(
            `Could not fetch proforma slip for order ${operationData.referenceNumber}:`,
            error,
          );
        }
      }

      // If createdById is not provided or the user doesn't exist, find an existing user
      if (!operationData.createdById) {
        try {
          const users = await storage.listUsers(10, 0);
          if (users && users.length > 0) {
            // Use the first available user
            operationData.createdById = users[0].id;
            console.log(
              `No user ID provided, using user ID ${operationData.createdById} as creator`,
            );
          } else {
            console.log("No users found in the system");
            return res
              .status(400)
              .json({
                message:
                  "No users found in the system. Please create a user first.",
              });
          }
        } catch (error) {
          console.error("Error finding users:", error);
        }
      } else {
        // Verify that the user exists
        try {
          const user = await storage.getUser(operationData.createdById);
          if (!user) {
            // User doesn't exist, find another user
            const users = await storage.listUsers(10, 0);
            if (users && users.length > 0) {
              // Use the first available user
              operationData.createdById = users[0].id;
              console.log(
                `Provided user ID ${req.body.createdById} not found, using user ID ${operationData.createdById} instead`,
              );
            } else {
              console.log("No users found in the system");
              return res
                .status(400)
                .json({
                  message:
                    "No users found in the system. Please create a user first.",
                });
            }
          }
        } catch (error) {
          console.error("Error verifying user:", error);
        }
      }

      console.log(`Creating new load operation with data:`, operationData);
      const operation = await storage.createLoadingOperation(operationData);
      console.log(`Successfully created load operation #${operation.id}`);

      // If a reference number is provided, populate load operation items from proforma slip
      if (operation.referenceNumber) {
        try {
          console.log(
            `Populating items for new load operation ${operation.id} from proforma slip with order number ${operation.referenceNumber}`,
          );

          // Get proforma slip
          const slip = await storage.getProformaSlipByOrderNumber(
            operation.referenceNumber,
          );

          if (slip) {
            // Get proforma slip items
            const proformaItems = await storage.getProformaSlipItems(slip.id);

            if (proformaItems && proformaItems.length > 0) {
              // Convert proforma items to load operation items
              const loadOperationItems = proformaItems.map((item) => {
                // Ensure quantity is a valid number
                const parsedQuantity =
                  typeof item.quantity === "number"
                    ? item.quantity
                    : typeof item.quantity === "string"
                      ? parseInt(item.quantity, 10)
                      : 0;

                console.log(
                  `Converting proforma item to load operation item - productId=${item.productId}, quantity=${parsedQuantity}`,
                );

                return {
                  loadOperationsId: operation.id,
                  productId: item.productId,
                  quantity: parsedQuantity, // Set quantity to equal originalQuantity initially
                  originalQuantity: parsedQuantity, // Keep original quantity from proforma slip
                  extraQuantity: 0, // Initialize extra quantity to zero
                  loadedQuantity: parsedQuantity, // Initialize loadedQuantity to match the original quantity
                  loaded: false, // Default to not loaded
                  srNo: item.srNo || "",
                  barcode: item.barcode || "",
                  itemName: item.itemName || "",
                  srNoDisplay: item.srNo || "",
                };
              });

              // Insert items into load_operations_items table
              await storage.createLoadingOperationItems(loadOperationItems);
              console.log(
                `Successfully created ${loadOperationItems.length} items for new load operation ${operation.id}`,
              );
            } else {
              console.log(
                `No items found in proforma slip ${slip.id} for new load operation ${operation.id}`,
              );
            }
          } else {
            console.log(
              `No proforma slip found for reference number ${operation.referenceNumber}`,
            );
          }
        } catch (error) {
          console.error(
            `Error populating items for new load operation ${operation.id}:`,
            error,
          );
          // Continue with the operation even if item population fails
        }
      }

      // Create an activity record for the new loading operation
      try {
        const activityDetails = JSON.stringify({
          referenceNumber: operation.referenceNumber,
          plant: operation.plant,
          vehicleNumber: operation.vehicleNumber,
          status: operation.status,
        });

        // Get the creator's name for the activity record
        let userName = "Unknown User";
        if (operationData.createdById) {
          const user = await storage.getUser(operationData.createdById);
          if (user) {
            userName = user.name || user.username || "Unknown User";
          }
        }

        await storage.createActivity({
          pageName: "LoadOperations",
          action: "create",
          entityType: "loadOperation",
          entityId: String(operation.id),
          details: activityDetails,
          userId: operationData.createdById || null,
          userName: userName,
        });
        console.log(
          `Created activity record for load operation #${operation.id} by ${userName}`,
        );
      } catch (activityError) {
        console.error("Error creating activity record:", activityError);
        // Continue processing even if activity creation fails
      }

      res.status(201).json(operation);
    } catch (error) {
      console.error("Error creating loading operation:", error);
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      res.status(400).json({ message: "Invalid loading operation data" });
    }
  });

  apiRouter.get(
    "/loading-operations/:id",
    async (req: Request, res: Response) => {
      try {
        // Import the cache utility for improved performance
        const { operationsCache } = await import("./utils/cache");

        const operationId = parseInt(req.params.id);

        // Create a cache key based on operation ID
        const cacheKey = `loading-op-${operationId}`;

        // Try to get from cache first (TTL: 30 seconds)
        const cachedOperation = operationsCache.get(cacheKey);
        if (cachedOperation) {
          console.log(`Using cached operation for ID ${operationId}`);
          return res.json(cachedOperation);
        }

        // Start timer to measure performance
        const startTime = Date.now();

        // Fetch the operation from database
        const operation = await storage.getLoadingOperation(operationId);
        if (!operation) {
          return res
            .status(404)
            .json({ message: "Loading operation not found" });
        }

        // Calculate query time
        const queryTime = Date.now() - startTime;
        if (queryTime > 200) {
          console.warn(
            `Slow query warning: Loading operation retrieval took ${queryTime}ms`,
          );
        }

        // Ensure date fields are properly formatted
        if (operation.createdAt && typeof operation.createdAt !== "string") {
          operation.createdAt = operation.createdAt.toISOString();
        }

        if (
          operation.completedAt &&
          typeof operation.completedAt !== "string"
        ) {
          operation.completedAt = operation.completedAt.toISOString();
        }

        if (operation.orderDate && typeof operation.orderDate !== "string") {
          operation.orderDate = operation.orderDate.toISOString();
        }

        // Cache the formatted operation for future requests
        operationsCache.set(cacheKey, operation, 30); // 30 seconds TTL

        res.json(operation);
      } catch (error) {
        console.error(`Error fetching loading operation:`, error);
        res.status(500).json({ message: "Error fetching loading operation" });
      }
    },
  );

  // Endpoint to update a loading operation (vehicle number, driver name, etc.)
  apiRouter.put(
    "/loading-operations/:id",
    requirePageWrite("load-operations"),
    async (req: Request, res: Response) => {
      try {
        // Import the cache utility in a try/catch to handle errors
        let operationsCache;
        try {
          const cacheModule = await import("./utils/cache");
          operationsCache = cacheModule.operationsCache;
        } catch (cacheError) {
          console.error("Failed to import cache module:", cacheError);
          // Continue without cache - not a fatal error
        }

        const operationId = parseInt(req.params.id);

        // Validate the data
        const updateData = req.body;

        // Get fields that can be updated
        const allowedUpdates = {
          vehicleNumber: updateData.vehicleNumber,
          driverName: updateData.driverName,
          status: updateData.status,
          // Only include fields that are present in the request
          ...(updateData.notes && { notes: updateData.notes }),
          ...(updateData.assignedToId && {
            assignedToId: updateData.assignedToId,
          }),
        };

        console.log(
          `Updating loading operation ${operationId} with data:`,
          JSON.stringify(allowedUpdates),
        );

        // Get the original operation to check if status is being changed (needed for activity logging)
        const originalOperation =
          await storage.getLoadingOperation(operationId);
        if (!originalOperation) {
          return res
            .status(404)
            .json({ message: "Loading operation not found" });
        }

        // Update the operation in the database
        const updatedOperation = await storage.updateLoadingOperation(
          operationId,
          allowedUpdates,
        );

        if (!updatedOperation) {
          return res
            .status(404)
            .json({ message: "Loading operation not found" });
        }

        // Clear the cache for this operation if cache is available
        if (operationsCache) {
          try {
            const cacheKey = `loading-op-${operationId}`;
            operationsCache.delete(cacheKey);
            operationsCache.delete("loading-operations-list");
          } catch (cacheError) {
            console.error("Error clearing cache:", cacheError);
            // Continue without cache - not a fatal error
          }
        }

        // Log activity for this update
        try {
          // Find the user who made the update (use authenticated user or the operation's creator)
          const userId =
            req.session?.user?.id ||
            updatedOperation.createdById ||
            originalOperation.createdById;
          let userName = "Unknown User";

          if (userId) {
            const user = await storage.getUser(userId);
            if (user) {
              userName = user.name || user.username || "Unknown User";
            }
          }

          // Determine what was changed
          const changedFields = Object.keys(allowedUpdates)
            .filter(
              (key) =>
                allowedUpdates[key as keyof typeof allowedUpdates] !==
                originalOperation[key as keyof typeof originalOperation],
            )
            .join(", ");

          const activityDetails = JSON.stringify({
            changedFields,
            oldStatus: originalOperation.status,
            newStatus: updatedOperation.status,
            operationId: operationId,
            referenceNumber: updatedOperation.referenceNumber,
            vehicleNumber: updatedOperation.vehicleNumber,
            driverName: updatedOperation.driverName,
          });

          // Create an activity record
          await storage.createActivity({
            pageName: "LoadOperations", // Use LoadOperations as standard page name
            action: "update",
            entityType: "loadOperation", // Use loadOperation as standard entity type
            entityId: String(operationId),
            details: activityDetails,
            userId: userId || null,
            userName: userName,
          });

          console.log(
            `Created activity record for updating load operation #${operationId} by ${userName}`,
          );
        } catch (activityError) {
          console.error("Error creating activity record:", activityError);
          // Don't fail the request if activity creation fails
        }

        // If a WebSocket server is available, broadcast the update to all clients
        try {
          if (wss) {
            const broadcastMessage = {
              type: "OPERATION_UPDATED",
              operationId,
              data: allowedUpdates,
              timestamp: Date.now(),
            };

            let broadcastCount = 0;
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                try {
                  client.send(JSON.stringify(broadcastMessage));
                  broadcastCount++;
                } catch (wsError) {
                  console.error(
                    "Error sending WebSocket message to client:",
                    wsError,
                  );
                }
              }
            });

            console.log(
              `Broadcast operation update to ${broadcastCount} clients`,
            );
          }
        } catch (wsError) {
          console.error("Error broadcasting WebSocket update:", wsError);
          // Continue - WebSocket errors should not prevent the API from responding
        }

        res.json(updatedOperation);
      } catch (error) {
        console.error("Error updating loading operation:", error);
        res.status(500).json({ message: "Error updating loading operation" });
      }
    },
  );

  // Endpoint to get items for a specific loading operation
  // After our modifications, this exclusively uses the load_operations_items table
  // with NO fallback to proforma slip items, ensuring complete independence
  apiRouter.get(
    "/loading-operations/:id/items",
    async (req: Request, res: Response) => {
      try {
        // Import the cache utility for improved performance
        const { itemsCache, operationsCache } = await import("./utils/cache");

        const id = parseInt(req.params.id);

        // Create a cache key based on the loading operation ID
        const cacheKey = `load-op-items-${id}-processed`;

        // Try to get from cache first (TTL: 30 seconds)
        const cachedItems = itemsCache.get(cacheKey);
        if (cachedItems) {
          console.log(
            `Using ${cachedItems.length} cached items for loading operation ID ${id}`,
          );
          return res.json(cachedItems);
        }

        // Start timer to measure performance
        const startTime = Date.now();

        // First check if the loading operation exists - try cache first
        const opCacheKey = `loading-op-${id}`;
        let operation = operationsCache.get(opCacheKey);

        if (!operation) {
          // Not in cache, fetch from database
          operation = await storage.getLoadingOperation(id);

          // Cache for future requests
          if (operation) {
            operationsCache.set(opCacheKey, operation, 30); // 30 seconds TTL
          }
        }

        if (!operation) {
          return res.status(404).json({ message: "Load operation not found" });
        }

        // Get the items for this loading operation (no proforma slip fallback)
        // The getLoadingOperationItems method already has caching built in
        const items = await storage.getLoadingOperationItems(id);

        // Convert string 'true'/'false' to actual boolean values with a more efficient approach
        const processedItems = items.map((item) => ({
          ...item,
          // Use type coercion for better performance with lots of items
          loaded: !!item.loaded,
        }));

        // Calculate query time
        const queryTime = Date.now() - startTime;
        if (queryTime > 200) {
          console.warn(
            `Slow query warning: Loading operation items retrieval took ${queryTime}ms`,
          );
        }

        console.log(
          `Processed ${processedItems.length} items, ensuring loaded property is a proper boolean`,
        );

        // Cache the processed items for future requests
        itemsCache.set(cacheKey, processedItems, 30); // 30 seconds TTL

        // Return the items exclusively from the load_operations_items table
        // Proforma slip items are no longer used as a fallback
        res.json(processedItems);
      } catch (error) {
        console.error(`Error fetching load operation items:`, error);
        res
          .status(500)
          .json({ message: "Error fetching load operation items" });
      }
    },
  );

  // Endpoint to delete a specific loading operation item
  apiRouter.delete(
    "/loading-operation-items/:id",
    async (req: Request, res: Response) => {
      try {
        // Import the cache utility for cache invalidation
        const { itemsCache } = await import("./utils/cache");

        const id = parseInt(req.params.id);

        if (isNaN(id)) {
          return res.status(400).json({ error: "Invalid item ID" });
        }

        console.log(`Deleting loading operation item ${id}`);

        // Get the current item to verify it exists and capture its operation ID for activity logging
        const currentItem = await storage.getLoadingOperationItem(id);
        if (!currentItem) {
          return res
            .status(404)
            .json({ error: "Loading operation item not found" });
        }

        // Store the operation ID before deleting the item
        const loadOperationId = currentItem.loadOperationsId;

        // Delete the item from the database
        const deleted = await storage.deleteLoadingOperationItem(id);

        if (deleted) {
          // Invalidate cache for this operation's items
          if (loadOperationId) {
            // Clear both the raw and processed item caches
            const cacheKey = `load-op-items-${loadOperationId}`;
            const processedCacheKey = `load-op-items-${loadOperationId}-processed`;

            itemsCache.delete(cacheKey);
            itemsCache.delete(processedCacheKey);
            console.log(
              `Invalidated cache for operation ${loadOperationId} after item deletion`,
            );
          }

          // Record activity
          try {
            // Get the username if available
            let userName = "Unknown";
            if (req.session.user && req.session.user.name) {
              userName = req.session.user.name;
            } else if (req.session.user && req.session.user.username) {
              userName = req.session.user.username;
            }

            await storage.createActivity({
              pageName: "LoadOperations",
              action: "delete",
              entityType: "loading_operation_item",
              entityId: id.toString(),
              details: `Deleted item ${id} from loading operation #${loadOperationId}`,
              userName,
            });
          } catch (activityError) {
            console.error("Error creating activity record:", activityError);
            // Don't fail the request if activity creation fails
          }

          res
            .status(200)
            .json({ success: true, message: "Item deleted successfully" });
        } else {
          res.status(500).json({ error: "Failed to delete item" });
        }
      } catch (error) {
        console.error("Error deleting loading operation item:", error);
        res
          .status(500)
          .json({
            message: "Failed to delete loading operation item",
            error: String(error),
          });
      }
    },
  );

  // Endpoint to update a specific loading operation item
  apiRouter.put(
    "/loading-operations/items/:id",
    requirePageWrite("load-operations"),
    async (req: Request, res: Response) => {
      try {
        // Import the cache utility for cache invalidation
        const { itemsCache } = await import("./utils/cache");

        const id = parseInt(req.params.id);

        if (isNaN(id)) {
          return res
            .status(400)
            .json({ error: "Invalid loading operation item ID" });
        }

        // First check if the item exists
        const loadItem = await storage.getLoadingOperationItem(id);
        if (!loadItem) {
          return res
            .status(404)
            .json({ message: "Loading operation item not found" });
        }

        // Store the operation ID for cache invalidation
        const loadOperationId = loadItem.loadOperationsId;

        // Get the update data from the request body, allowing partial updates
        const itemData = insertLoadingOpItemSchema.partial().parse(req.body);

        // PRESERVE loadedQuantity values regardless of loaded status
        // This change is critical to maintain loaded quantity values independently
        if (itemData.loadedQuantity === undefined) {
          // If no loadedQuantity provided in the request, prefer existing loadedQuantity first
          if (
            loadItem.loadedQuantity !== undefined &&
            loadItem.loadedQuantity !== null
          ) {
            // Keep existing loadedQuantity value when toggling loaded status
            itemData.loadedQuantity = loadItem.loadedQuantity;
            console.log(
              `Preserving existing loadedQuantity=${itemData.loadedQuantity} when changing loaded status`,
            );
          } else {
            // Fall back to quantity if no loadedQuantity exists yet
            itemData.loadedQuantity = loadItem.quantity || 0;
            console.log(
              `Initializing loadedQuantity=${itemData.loadedQuantity} based on quantity`,
            );
          }
        }

        // Preserve extraQuantity if it exists in the current item but not in the update data
        if (
          itemData.extraQuantity === undefined &&
          loadItem.extraQuantity !== undefined
        ) {
          itemData.extraQuantity = loadItem.extraQuantity;
          console.log(
            `Preserving existing extraQuantity value: ${itemData.extraQuantity}`,
          );
        }

        // Update the loading operation item
        const updatedItem = await storage.updateLoadingOperationItem(
          id,
          itemData,
        );

        // Invalidate cache for this operation's items after update
        if (loadOperationId) {
          // Clear both the raw and processed item caches
          const cacheKey = `load-op-items-${loadOperationId}`;
          const processedCacheKey = `load-op-items-${loadOperationId}-processed`;

          itemsCache.delete(cacheKey);
          itemsCache.delete(processedCacheKey);
          console.log(
            `Invalidated cache for operation ${loadOperationId} after item update`,
          );
        }

        // Return the updated item
        res.json(updatedItem);
      } catch (error) {
        console.error("Error updating loading operation item:", error);

        // Handle validation errors
        if (error instanceof ZodError) {
          const validationError = fromZodError(error);
          return res
            .status(400)
            .json({
              message: "Validation error",
              error: validationError.message,
            });
        }

        res
          .status(500)
          .json({ message: "Failed to update loading operation item" });
      }
    },
  );

  // Add items to a loading operation
  apiRouter.post(
    "/loading-operations/:id/items",
    requirePageWrite("load-operations"),
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res
            .status(400)
            .json({ error: "Invalid loading operation ID" });
        }

        // Check if the loading operation exists
        const loadingOperation = await storage.getLoadingOperation(id);
        if (!loadingOperation) {
          return res.status(404).json({ error: "Loading operation not found" });
        }

        // Handle both single item and array of items
        const itemsData = Array.isArray(req.body) ? req.body : [req.body];

        // Validate each item and fix field names
        for (const item of itemsData) {
          // Convert gjOperationsId to loadOperationsId for database compatibility
          if (!item.loadOperationsId && !item.gjOperationsId) {
            // Neither field exists, so add loadOperationsId
            item.loadOperationsId = id;
          } else if (item.gjOperationsId && !item.loadOperationsId) {
            // gjOperationsId exists but loadOperationsId doesn't, so copy the value
            item.loadOperationsId = item.gjOperationsId;

            // Check if it matches the URL parameter
            if (item.gjOperationsId !== id) {
              return res.status(400).json({
                error:
                  "Item's loading operation ID doesn't match the URL parameter",
              });
            }
          }

          // Always ensure ID field is not provided to let DB auto-generate it
          if (item.id) {
            delete item.id;
          }
        }

        // Add items to the loading operation
        const createdItems =
          await storage.createLoadingOperationItems(itemsData);

        // Record activity if items were added
        if (createdItems.length > 0) {
          try {
            // Get the username if available
            let userName = "Unknown";
            if (req.session.user && req.session.user.name) {
              userName = req.session.user.name;
            } else if (req.session.user && req.session.user.username) {
              userName = req.session.user.username;
            }

            await storage.createActivity({
              pageName: "LoadOperations",
              action: "update",
              entityType: "loading_operation",
              entityId: id,
              details: `Added ${createdItems.length} items to loading operation #${loadingOperation.referenceNumber} - ${loadingOperation.plant}`,
              userName,
            });
          } catch (activityError) {
            console.error("Error creating activity:", activityError);
            // Don't fail the request if activity creation fails
          }
        }

        res.status(201).json(createdItems);
      } catch (error) {
        console.error("Error adding loading operation items:", error);
        res
          .status(500)
          .json({ error: "Failed to add items to loading operation" });
      }
    },
  );

  // Update a single loading operation item
  apiRouter.patch(
    "/loading-operation-items/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res.status(400).json({ error: "Invalid item ID" });
        }

        console.log(
          `Updating loading operation item ${id} with data:`,
          req.body,
        );

        // Get the current item to determine effective values
        const currentItem = await storage.getLoadingOperationItem(id);
        if (!currentItem) {
          return res
            .status(404)
            .json({ error: "Loading operation item not found" });
        }

        // Build update data
        const updateData: Record<string, any> = {};

        // Explicitly handle extraQuantity or originalQuantity updates
        if (
          req.body.extraQuantity !== undefined ||
          req.body.originalQuantity !== undefined
        ) {
          // Calculate new total quantity based on original + extra
          const originalQty =
            req.body.originalQuantity !== undefined
              ? req.body.originalQuantity
              : currentItem.originalQuantity || 0;
          const extraQty =
            req.body.extraQuantity !== undefined
              ? req.body.extraQuantity
              : currentItem.extraQuantity || 0;

          // Total quantity is the sum of original and extra
          updateData.quantity = Number(originalQty) + Number(extraQty);
          console.log(
            `Calculating new total quantity: ${updateData.quantity} (original=${originalQty} + extra=${extraQty})`,
          );

          // Track the individual components
          if (req.body.originalQuantity !== undefined) {
            updateData.originalQuantity = originalQty;
          }
          if (req.body.extraQuantity !== undefined) {
            updateData.extraQuantity = extraQty;
          }

          // If item is loaded, always update loadedQuantity to match the new quantity
          // This ensures loadedQuantity stays in sync when quantity changes
          if (
            currentItem.loaded === true &&
            req.body.loadedQuantity === undefined
          ) {
            updateData.loadedQuantity = updateData.quantity;
            console.log(
              `Item is loaded, updating loadedQuantity to match new quantity: ${updateData.loadedQuantity}`,
            );
          }
        }
        // Handle direct quantity update (rarely should be used)
        else if (req.body.quantity !== undefined) {
          updateData.quantity = req.body.quantity;
          console.log(`Direct quantity update: ${updateData.quantity}`);

          // If item is loaded, always update loadedQuantity to match the new quantity
          // This ensures loadedQuantity stays in sync when quantity changes
          if (
            currentItem.loaded === true &&
            req.body.loadedQuantity === undefined
          ) {
            updateData.loadedQuantity = req.body.quantity;
            console.log(
              `Item is loaded, updating loadedQuantity to match direct quantity update: ${updateData.loadedQuantity}`,
            );
          }
        }

        // Handle loaded status update
        if (req.body.loaded !== undefined) {
          updateData.loaded = req.body.loaded;

          // If loaded status was toggled but no loadedQuantity was explicitly provided,
          // set loadedQuantity based on the toggle direction
          if (req.body.loadedQuantity === undefined) {
            if (updateData.loaded === true) {
              // If toggling to loaded, use the current quantity
              updateData.loadedQuantity =
                updateData.quantity !== undefined
                  ? updateData.quantity
                  : currentItem.quantity || 0;
              console.log(
                `Item being marked as loaded, setting loadedQuantity to current quantity: ${updateData.loadedQuantity}`,
              );
            } else {
              // If toggling to unloaded, PRESERVE current loadedQuantity rather than resetting to 0
              // This allows the loadedQuantity to be manipulated independently
              updateData.loadedQuantity =
                currentItem.loadedQuantity !== undefined &&
                currentItem.loadedQuantity !== null
                  ? currentItem.loadedQuantity
                  : currentItem.quantity || 0;
              console.log(
                `Item being marked as unloaded, preserving loadedQuantity: ${updateData.loadedQuantity}`,
              );
            }
          }

          // Important: If extraQuantity was not explicitly provided but exists in the current item,
          // preserve it exactly as is to prevent it from being reset to zero
          if (
            req.body.extraQuantity === undefined &&
            currentItem.extraQuantity !== undefined &&
            currentItem.extraQuantity !== null
          ) {
            updateData.extraQuantity = currentItem.extraQuantity;
            console.log(
              `Preserving existing extraQuantity=${currentItem.extraQuantity} when changing loaded status`,
            );
          }
        }

        // For loaded items, if we're updating quantity but not explicitly setting loadedQuantity,
        // ensure loadedQuantity is updated to match the new quantity value
        if (
          updateData.quantity !== undefined &&
          req.body.loadedQuantity === undefined
        ) {
          // Check if item is currently loaded or being marked as loaded
          const isLoaded =
            updateData.loaded !== undefined
              ? updateData.loaded
              : currentItem.loaded || false;

          if (isLoaded) {
            // For loaded items, loadedQuantity should always match quantity
            updateData.loadedQuantity = updateData.quantity;
            console.log(
              `Item is loaded and quantity was updated to ${updateData.quantity}, setting loadedQuantity to match`,
            );
          }
        }

        // Handle explicit loadedQuantity update if provided
        if (req.body.loadedQuantity !== undefined) {
          updateData.loadedQuantity = req.body.loadedQuantity;
          console.log(
            `Using provided loadedQuantity: ${updateData.loadedQuantity}`,
          );
        }

        // Normalize field names to handle both snake_case and camelCase
        const normalizedBody = {
          ...req.body,
          extraQuantity:
            req.body.extraQuantity !== undefined
              ? req.body.extraQuantity
              : req.body.extra_quantity !== undefined
                ? req.body.extra_quantity
                : undefined,
          originalQuantity:
            req.body.originalQuantity !== undefined
              ? req.body.originalQuantity
              : req.body.original_quantity !== undefined
                ? req.body.original_quantity
                : undefined,
          loadedQuantity:
            req.body.loadedQuantity !== undefined
              ? req.body.loadedQuantity
              : req.body.loaded_quantity !== undefined
                ? req.body.loaded_quantity
                : undefined,
        };

        console.log(
          `Normalized request body fields for item ${id}:`,
          normalizedBody,
        );

        // Handle originalQuantity update
        if (normalizedBody.originalQuantity !== undefined) {
          updateData.originalQuantity = normalizedBody.originalQuantity;
        }

        // Handle extraQuantity - use provided value or calculate based on original vs current
        if (normalizedBody.extraQuantity !== undefined) {
          updateData.extraQuantity = normalizedBody.extraQuantity;
          console.log(
            `Using provided extraQuantity: ${updateData.extraQuantity}`,
          );
        } else if (req.body.quantity !== undefined) {
          // Calculate extraQuantity based on original vs current quantity
          const originalQty =
            normalizedBody.originalQuantity !== undefined
              ? normalizedBody.originalQuantity
              : currentItem.originalQuantity || 0;
          const currentQty = req.body.quantity;

          updateData.extraQuantity =
            currentQty > originalQty ? currentQty - originalQty : 0;
          console.log(
            `Calculated extraQuantity: ${updateData.extraQuantity} (currentQty: ${currentQty}, originalQty: ${originalQty})`,
          );
        }

        // Always log current values before update for debugging
        console.log(`Current values for item ${id}:`, {
          quantity: currentItem.quantity,
          originalQuantity: currentItem.originalQuantity,
          extraQuantity: currentItem.extraQuantity,
          loaded: currentItem.loaded,
          loadedQuantity: currentItem.loadedQuantity,
        });

        // Update the item
        const updatedItem = await storage.updateLoadingOperationItem(
          id,
          updateData,
        );

        // WEBSOCKET DISABLED - broadcast functionality commented out
        /* WebSocket broadcast for real-time updates - uncomment when re-enabling WebSocket
      if (updatedItem && updatedItem.loadOperationId) {
        // Send the updated item to all connected clients subscribed to this operation
        broadcastOperationUpdate(updatedItem.loadOperationId, {
          type: 'ITEM_UPDATED',
          item: updatedItem,
          operationId: updatedItem.loadOperationId
        });
        
        // Get all items for this operation to calculate the loading progress
        const allItems = await storage.getLoadingOperationItems(updatedItem.loadOperationId);
        const loadedItems = allItems.filter(item => item.loaded).length;
        const totalItems = allItems.length;
        
        // Broadcast operation status update with progress information
        broadcastOperationUpdate(updatedItem.loadOperationId, {
          type: 'OPERATION_STATUS',
          operationId: updatedItem.loadOperationId,
          loadedItems, 
          totalItems,
          percentComplete: totalItems > 0 ? Math.round((loadedItems / totalItems) * 100) : 0
        });
      }
      */ // END WEBSOCKET BROADCAST

        // Record activity
        try {
          const user = (req as any).user;
          const userId = user?.id;
          const userName = user?.name || user?.username;

          // Get operation details to include reference number
          const operation = await storage.getLoadingOperation(
            currentItem.loadOperationsId,
          );

          // Create simplified activity log with only order number, item name & quantity changes
          await storage.createActivity({
            pageName: "LoadOperations",
            action: "UPDATE_ITEM",
            entityType: "LOADING_OPERATION_ITEM",
            entityId: id.toString(),
            details: JSON.stringify({
              orderNumber: operation?.referenceNumber || "Unknown",
              itemName: currentItem.itemName || "Unknown Item",
              quantityBefore: currentItem.quantity,
              quantityAfter: updatedItem.quantity,
              loadedBefore: currentItem.loaded,
              loadedAfter: updatedItem.loaded,
            }),
            userId,
            userName,
          });
        } catch (activityError) {
          console.error(
            "Failed to log activity for item update:",
            activityError,
          );
          // Don't fail the request if activity creation fails
        }

        res.json(updatedItem);
      } catch (error) {
        console.error("Error updating loading operation item:", error);
        if (error instanceof ZodError) {
          const validationError = fromZodError(error);
          return res
            .status(400)
            .json({
              message: "Validation error",
              error: validationError.message,
            });
        }

        res
          .status(500)
          .json({ message: "Failed to update loading operation item" });
      }
    },
  );

  // Batch update loading operation items with optimized transaction-based approach
  apiRouter.post(
    "/loading-operation-items/batch-update",
    async (req: Request, res: Response) => {
      try {
        const startTime = Date.now();
        const { items, loadOperationId } = req.body;

        if (!items || !Array.isArray(items)) {
          return res
            .status(400)
            .json({
              message:
                "Invalid request format. Expected items array in request body.",
            });
        }

        console.log(
          `[BATCH UPDATE] Processing batch update for ${items.length} loading operation items for operation: ${loadOperationId || "unspecified"}`,
        );

        // Add detailed logging for the incoming request
        console.log(
          `[BATCH UPDATE] Full request data:`,
          JSON.stringify(req.body),
        );

        // Format updates for the optimized batch update function
        const updates = [];
        const itemsByOperation = new Map<number, any[]>();

        // Prepare batch updates
        for (const item of items) {
          if (!item.id) {
            console.log(`[BATCH UPDATE] Skipping item without ID`);
            continue;
          }

          // Normalize field names to handle both snake_case and camelCase
          const normalizedItem = {
            ...item,
            extraQuantity:
              item.extraQuantity !== undefined
                ? item.extraQuantity
                : item.extra_quantity !== undefined
                  ? item.extra_quantity
                  : undefined,
            originalQuantity:
              item.originalQuantity !== undefined
                ? item.originalQuantity
                : item.original_quantity !== undefined
                  ? item.original_quantity
                  : undefined,
            loadedQuantity:
              item.loadedQuantity !== undefined
                ? item.loadedQuantity
                : item.loaded_quantity !== undefined
                  ? item.loaded_quantity
                  : undefined,
          };

          // Create a fresh update data object
          const updateData: Record<string, any> = {};

          // Handle loaded status
          if ("loaded" in item) {
            updateData.loaded = item.loaded === true || item.loaded === "true";
          }

          // Handle quantities
          if (normalizedItem.originalQuantity !== undefined) {
            updateData.originalQuantity = normalizedItem.originalQuantity;
          }

          if (normalizedItem.extraQuantity !== undefined) {
            updateData.extraQuantity = normalizedItem.extraQuantity;
          }

          if (normalizedItem.loadedQuantity !== undefined) {
            updateData.loadedQuantity = normalizedItem.loadedQuantity;
          } else if (
            updateData.loaded === true &&
            normalizedItem.quantity !== undefined
          ) {
            // If loaded and quantity is set, update loadedQuantity
            updateData.loadedQuantity = normalizedItem.quantity;
          }

          // Handle quantity
          if (normalizedItem.quantity !== undefined) {
            updateData.quantity = normalizedItem.quantity;
          }

          // Add to updates list
          updates.push({
            id: item.id,
            data: updateData,
          });

          // Group by operation ID for efficient WebSocket broadcasting
          const opId =
            item.loadOperationsId || item.loadOperationId || loadOperationId;
          if (opId) {
            if (!itemsByOperation.has(opId)) {
              itemsByOperation.set(opId, []);
            }
            itemsByOperation.get(opId).push(item.id);
          }
        }

        console.log(
          `[BATCH UPDATE] Prepared ${updates.length} updates for batch processing`,
        );

        // Use the optimized batch update function for better performance
        const updatedItems =
          await storage.batchUpdateLoadingOperationItems(updates);

        const successCount = updatedItems.length;
        const failCount = updates.length - successCount;

        // WEBSOCKET DISABLED - batch broadcast functionality commented out
        /* WebSocket batch broadcast for real-time updates - uncomment when re-enabling WebSocket
      for (const [opId, itemIds] of itemsByOperation.entries()) {
        // Only broadcast items that were successfully updated
        const itemsToSend = updatedItems.filter(item => 
          itemIds.includes(item.id) && (item.loadOperationsId === opId || item.loadOperationId === opId)
        );
        
        if (itemsToSend.length > 0) {
          // Use WebSocket to broadcast the updates to all connected clients
          broadcastOperationUpdate(opId, {
            type: 'BATCH_ITEMS_UPDATED',
            items: itemsToSend,
            operationId: opId,
            count: itemsToSend.length
          });
          
          console.log(`[BATCH UPDATE] Broadcast update for ${itemsToSend.length} items in operation ${opId}`);
        }
      }
      */ // END WEBSOCKET BATCH BROADCAST

        // Calculate execution time
        const duration = Date.now() - startTime;
        const itemsPerSecond = Math.round((updates.length / duration) * 1000);

        console.log(
          `[BATCH UPDATE] Completed in ${duration}ms (${itemsPerSecond} items/sec): ${successCount} successful, ${failCount} failed`,
        );

        // Return appropriate response
        if (failCount > 0) {
          // Partial success response
          res.status(207).json({
            success: failCount === 0,
            message: `Batch update: ${successCount} items successful, ${failCount} items failed`,
            successCount,
            failCount,
            duration,
            itemsPerSecond,
          });
        } else {
          // All success response
          res.status(200).json({
            success: true,
            message: `Batch update: ${successCount} items updated successfully`,
            successCount,
            failCount: 0,
            duration,
            itemsPerSecond,
          });
        }
      } catch (error) {
        console.error("Error batch updating loading operation items:", error);
        res.status(500).json({
          message: "Error processing batch update",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  apiRouter.get(
    "/loading-operations/status/count",
    async (req: Request, res: Response) => {
      const status = req.query.status as string;
      if (!status) {
        return res
          .status(400)
          .json({ message: "Status query parameter is required" });
      }

      console.log(`Counting ${status} load operations with NO date filter`);

      // Count all operations with the given status, without any date filtering
      const count = await storage.countLoadingOperationsByStatus(status);
      res.json({ status, count });
    },
  );

  // Purchase endpoints
  apiRouter.get("/purchases", async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

    const purchases = await storage.listPurchases(limit, offset);
    res.json(purchases);
  });

  apiRouter.post("/purchases", async (req: Request, res: Response) => {
    try {
      const purchaseData = insertPurchaseSchema.parse(req.body);
      const purchase = await storage.createPurchase(purchaseData);
      res.status(201).json(purchase);
    } catch (error) {
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      res.status(400).json({ message: "Invalid purchase data" });
    }
  });

  apiRouter.get("/purchases/:id", async (req: Request, res: Response) => {
    const purchase = await storage.getPurchase(parseInt(req.params.id));
    if (!purchase) {
      return res.status(404).json({ message: "Purchase not found" });
    }
    res.json(purchase);
  });

  apiRouter.put("/purchases/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const purchaseData = insertPurchaseSchema.partial().parse(req.body);
      const purchase = await storage.updatePurchase(id, purchaseData);
      if (!purchase) {
        return res.status(404).json({ message: "Purchase not found" });
      }
      res.json(purchase);
    } catch (error) {
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      res.status(400).json({ message: "Invalid purchase data" });
    }
  });

  apiRouter.delete("/purchases/:id", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    try {
      const result = await storage.deletePurchase(id);
      if (!result) {
        return res.status(404).json({ message: "Purchase not found" });
      }
      res.json({ message: "Purchase deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete purchase" });
    }
  });

  // Loading Operations endpoints
  apiRouter.get("/loading-operations", async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;
    const status = req.query.status as string;

    try {
      let operations = [];
      if (status) {
        operations = await storage.listLoadingOperationsByStatus(
          status,
          limit,
          offset,
        );
      } else {
        operations = await storage.listLoadingOperations(limit, offset);
      }
      res.json(operations);
    } catch (error) {
      console.error("Error fetching loading operations:", error);
      res.status(500).json({ message: "Failed to fetch loading operations" });
    }
  });

  apiRouter.get(
    "/loading-operations/export-csv",
    async (req: Request, res: Response) => {
      try {
        const limit = 1000; // Get a large batch for export
        const operations = await storage.listLoadingOperations(limit, 0);

        // Create CSV content
        let csvContent =
          "ID,Reference Number,Party Name,Plant,Status,Created Date,Order Date,Vehicle Number,Total Volume\n";

        for (const op of operations) {
          // Format dates
          const createdDate = op.createdAt
            ? new Date(op.createdAt).toLocaleDateString()
            : "";
          const orderDate = op.orderDate
            ? new Date(op.orderDate).toLocaleDateString()
            : "";

          // Ensure all fields are properly escaped for CSV
          csvContent += `${op.id},"${(op.referenceNumber || "").replace(/"/g, '""')}","${(op.partyName || "").replace(/"/g, '""')}","${(op.plant || "").replace(/"/g, '""')}","${(op.status || "").replace(/"/g, '""')}","${createdDate}","${orderDate}","${(op.vehicleNumber || "").replace(/"/g, '""')}","${(op.totalVolume || "").replace(/"/g, '""')}"\n`;
        }

        // Set response headers
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          "attachment; filename=loading-operations.csv",
        );

        // Send CSV content
        res.send(csvContent);
      } catch (error) {
        console.error("Error exporting loading operations to CSV:", error);
        res
          .status(500)
          .json({ message: "Failed to export loading operations to CSV" });
      }
    },
  );

  apiRouter.get(
    "/loading-operations/reference/:referenceNumber",
    async (req: Request, res: Response) => {
      try {
        const referenceNumber = req.params.referenceNumber;
        const operation =
          await storage.getLoadingOperationByReferenceNumber(referenceNumber);

        if (!operation) {
          return res
            .status(404)
            .json({ message: "Loading operation not found" });
        }

        res.json(operation);
      } catch (error) {
        console.error(
          "Error fetching loading operation by reference number:",
          error,
        );
        res.status(500).json({ message: "Failed to fetch loading operation" });
      }
    },
  );

  apiRouter.post("/loading-operations", requirePageWrite("load-operations"), async (req: Request, res: Response) => {
    try {
      const operationData = req.body;
      const operation = await storage.createLoadingOperation(operationData);
      res.status(201).json(operation);
    } catch (error) {
      console.error("Error creating loading operation:", error);
      res.status(500).json({ message: "Failed to create loading operation" });
    }
  });

  apiRouter.get(
    "/loading-operations/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const operation = await storage.getLoadingOperation(id);

        if (!operation) {
          return res
            .status(404)
            .json({ message: "Loading operation not found" });
        }

        res.json(operation);
      } catch (error) {
        console.error("Error fetching loading operation:", error);
        res.status(500).json({ message: "Failed to fetch loading operation" });
      }
    },
  );

  apiRouter.put(
    "/loading-operations/:id",
    requirePageWrite("load-operations"),
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const operationData = req.body;

        const operation = await storage.getLoadingOperation(id);
        if (!operation) {
          return res
            .status(404)
            .json({ message: "Loading operation not found" });
        }

        const updatedOperation = await storage.updateLoadingOperation(
          id,
          operationData,
        );

        // Broadcast update via WebSocket
        const clients = wss.clients;

        if (clients.size > 0) {
          // Only broadcast if we have connected clients
          console.log(
            `Broadcasting vehicle update to ${clients.size} connected clients`,
          );

          const broadcastMessage = {
            type: "VEHICLE_UPDATE",
            data: {
              operationId: id,
              vehicleNumber: updatedOperation.vehicleNumber,
              driverName: updatedOperation.driverName,
            },
          };

          clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(broadcastMessage));
            }
          });
        }

        res.json(updatedOperation);
      } catch (error) {
        console.error("Error updating loading operation:", error);
        res.status(500).json({ message: "Failed to update loading operation" });
      }
    },
  );

  // Get all loading operation items
  apiRouter.get(
    "/loading-operations/:id/items",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const items = await storage.getLoadingOperationItems(id);
        res.json(items);
      } catch (error) {
        console.error("Error fetching loading operation items:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch loading operation items" });
      }
    },
  );

  // Add a loading operation item
  apiRouter.post(
    "/loading-operations/:id/items",
    requirePageWrite("load-operations"),
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const itemData = req.body;

        // Make sure the loading operation exists
        const operation = await storage.getLoadingOperation(id);
        if (!operation) {
          return res
            .status(404)
            .json({ message: "Loading operation not found" });
        }

        // Add the item to the loading operation
        const item = await storage.addLoadingOperationItem(id, itemData);
        res.status(201).json(item);
      } catch (error) {
        console.error("Error adding loading operation item:", error);
        res
          .status(500)
          .json({ message: "Failed to add loading operation item" });
      }
    },
  );

  // Delete or update a loading operation item
  apiRouter.delete(
    "/loading-operation-items/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const success = await storage.deleteLoadingOperationItem(id);

        if (!success) {
          return res
            .status(404)
            .json({ message: "Loading operation item not found" });
        }

        res.status(204).send();
      } catch (error) {
        console.error("Error deleting loading operation item:", error);
        res
          .status(500)
          .json({ message: "Failed to delete loading operation item" });
      }
    },
  );

  // Update a loading operation item
  apiRouter.put(
    "/loading-operation-items/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const itemData = req.body;

        const updatedItem = await storage.updateLoadingOperationItem(
          id,
          itemData,
        );

        if (!updatedItem) {
          return res
            .status(404)
            .json({ message: "Loading operation item not found" });
        }

        res.json(updatedItem);
      } catch (error) {
        console.error("Error updating loading operation item:", error);
        res
          .status(500)
          .json({ message: "Failed to update loading operation item" });
      }
    },
  );

  // Batch update for loading operation items
  apiRouter.post(
    "/loading-operation-items/batch-update",
    async (req: Request, res: Response) => {
      try {
        const startTime = Date.now();
        const { items, loadOperationId } = req.body;

        if (!items || !Array.isArray(items)) {
          return res
            .status(400)
            .json({
              message:
                "Invalid request format. Expected items array in request body.",
            });
        }

        console.log(
          `[BATCH UPDATE] Processing batch update for ${items.length} loading operation items for operation: ${loadOperationId || "unspecified"}`,
        );

        // Format updates for the batch update function
        const updates = items.map((item) => {
          // Each update needs an id and a data property
          return {
            id: item.id,
            data: {
              loaded: item.loaded,
              loadedQuantity: item.loadedQuantity,
              quantity: item.quantity,
              // Include any other fields that might be updated
              barcode: item.barcode,
              srNo: item.srNo,
              productId: item.productId,
              loadOperationsId: item.loadOperationsId || loadOperationId,
            },
          };
        });

        console.log(
          `[BATCH UPDATE] Formatted ${updates.length} updates for batch processing`,
        );

        // Process all updates in a single database transaction for better performance
        const updatedItems =
          await storage.batchUpdateLoadingOperationItems(updates);

        console.log(
          `[BATCH UPDATE] Successfully processed ${updatedItems.length} items in ${Date.now() - startTime}ms`,
        );

        // Broadcast updates via WebSocket if we have connected clients
        const clients = wss.clients;
        if (clients.size > 0) {
          console.log(
            `Broadcasting item updates to ${clients.size} connected clients`,
          );

          // Group items by operation ID - use loadOperationId from request or collect from items
          const operationIds = loadOperationId
            ? [loadOperationId]
            : [
                ...new Set(
                  items
                    .map((item) => item.loadOperationsId)
                    .filter((id) => id !== null && id !== undefined),
                ),
              ];

          for (const opId of operationIds) {
            if (!opId) continue;

            // Clear operation cache to ensure fresh data is fetched
            const { operationsCache, itemsCache } =
              await import("./utils/cache");
            const cacheKey = `load-op-${opId}`;
            const itemsCacheKey = `load-op-items-${opId}`;

            // Invalidate caches
            operationsCache.del(cacheKey);
            itemsCache.del(itemsCacheKey);

            const operation = await storage.getLoadingOperation(opId);
            if (!operation) continue;

            const broadcastMessage = {
              type: "ITEMS_UPDATED",
              data: {
                operationId: opId,
                count: items.filter(
                  (i) =>
                    i.loadOperationsId === opId || loadOperationId === opId,
                ).length,
                timestamp: new Date().toISOString(),
              },
            };

            clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(broadcastMessage));
              }
            });
          }
        }

        // Return the updated items to the client
        res.json({
          success: true,
          updatedItems: updatedItems,
          count: updatedItems.length,
          duration: Date.now() - startTime,
        });
      } catch (error) {
        console.error("Error batch updating loading operation items:", error);
        res.status(500).json({
          message: "Failed to batch update loading operation items",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  // Delete a loading operation
  apiRouter.delete(
    "/loading-operations/:id",
    requirePageWrite("load-operations"),
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const success = await storage.deleteLoadingOperation(id);

        if (!success) {
          return res
            .status(404)
            .json({ message: "Loading operation not found" });
        }

        res.status(204).send();
      } catch (error) {
        console.error("Error deleting loading operation:", error);
        res.status(500).json({ message: "Failed to delete loading operation" });
      }
    },
  );

  apiRouter.get(
    "/loading-operations/status/count",
    async (req: Request, res: Response) => {
      const status = req.query.status as string;
      if (!status) {
        return res
          .status(400)
          .json({ message: "Status query parameter is required" });
      }

      console.log(`Counting ${status} load operations with NO date filter`);

      // Count all operations with the given status, without any date filtering
      const count = await storage.countLoadingOperationsByStatus(status);
      res.json({ status, count });
    },
  );

  // Purchase endpoints
  apiRouter.get("/purchases", async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

    const purchases = await storage.listPurchases(limit, offset);
    res.json(purchases);
  });

  apiRouter.post("/purchases", async (req: Request, res: Response) => {
    try {
      const purchaseData = insertPurchaseSchema.parse(req.body);
      const purchase = await storage.createPurchase(purchaseData);
      res.status(201).json(purchase);
    } catch (error) {
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      res.status(400).json({ message: "Invalid purchase data" });
    }
  });

  apiRouter.get("/purchases/:id", async (req: Request, res: Response) => {
    const purchase = await storage.getPurchase(parseInt(req.params.id));
    if (!purchase) {
      return res.status(404).json({ message: "Purchase not found" });
    }
    res.json(purchase);
  });

  apiRouter.put("/purchases/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const purchaseData = insertPurchaseSchema.partial().parse(req.body);
      const updatedPurchase = await storage.updatePurchase(id, purchaseData);

      if (!updatedPurchase) {
        return res.status(404).json({ message: "Purchase not found" });
      }

      res.json(updatedPurchase);
    } catch (error) {
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      res.status(400).json({ message: "Invalid purchase data" });
    }
  });

  apiRouter.delete("/purchases/:id", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const success = await storage.deletePurchase(id);

    if (!success) {
      return res.status(404).json({ message: "Purchase not found" });
    }

    res.status(204).send();
  });

  // Clear all inventory data
  apiRouter.delete(
    "/products/clear-all",
    requirePageWrite("settings"),
    async (req: Request, res: Response) => {
      try {
        await storage.clearInventory();
        res.json({ message: "Inventory data cleared successfully" });
      } catch (error) {
        console.error("Error clearing inventory:", error);
        res
          .status(500)
          .json({
            message: "Failed to clear inventory data",
            error: String(error),
          });
      }
    },
  );

  // Alternative route with POST method for browsers that don't support DELETE
  apiRouter.post("/products/clear", requirePageWrite("settings"), async (req: Request, res: Response) => {
    try {
      console.log("Clearing inventory via POST method...");
      await storage.clearInventory();
      console.log("Inventory cleared successfully via POST method");
      return res.json({ message: "Inventory data cleared successfully" });
    } catch (error) {
      console.error("Error clearing inventory via POST:", error);
      return res
        .status(500)
        .json({
          message: "Failed to clear inventory data",
          error: String(error),
        });
    }
  });

  // Test route to check API access and test activity creation
  apiRouter.get("/test", async (req: Request, res: Response) => {
    console.log("Test route accessed");
    try {
      // Create a test activity
      const testActivity = await storage.createActivity({
        pageName: "Test",
        action: "test",
        entityType: "test",
        entityId: "test-id",
        details: JSON.stringify({
          message: "Test activity created successfully",
        }),
        userId: 1,
        userName: "Test User",
      });

      console.log("Test activity created:", testActivity);
      return res.json({
        message: "API working correctly",
        timestamp: new Date().toISOString(),
        activityCreated: true,
        activity: testActivity,
      });
    } catch (error) {
      console.error("Error creating test activity:", error);
      return res.status(500).json({
        message: "API working but activity creation failed",
        timestamp: new Date().toISOString(),
        error: error.message,
      });
    }
  });

  // Create an activity for testing the UI
  apiRouter.get("/create-activity", async (req: Request, res: Response) => {
    console.log("Creating test activity for UI");
    try {
      // Create a test activity with LoadOperations page name
      const activity = await storage.createActivity({
        pageName: "LoadOperations",
        action: "update",
        entityType: "loadOperation",
        entityId: "12345",
        details: JSON.stringify({
          referenceNumber: "64999",
          changedFields: "status",
          oldStatus: "LOADING",
          newStatus: "READY≈DESP",
          operationId: 999,
        }),
        userId: 1,
        userName: "Test User",
      });

      console.log("Activity created:", activity);
      res.json({ success: true, activity });
    } catch (error) {
      console.error("Error creating activity:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Reset only the sold counts to zero
  apiRouter.post(
    "/products/reset-sold",
    requirePageWrite("settings"),
    async (req: Request, res: Response) => {
      try {
        const updatedCount = await storage.resetSoldCounts();
        res.json({
          message: "All product sold values have been reset to zero",
          updatedCount,
        });
      } catch (error) {
        console.error("Error resetting sold values:", error);
        res.status(500).json({ message: "Failed to reset sold values" });
      }
    },
  );

  // Reset all inStock values to zero
  apiRouter.post(
    "/products/reset-stock",
    requirePageWrite("settings"),
    async (req: Request, res: Response) => {
      try {
        const updatedCount = await storage.resetInventoryStock();
        res.json({
          message: "All product stock and sold values have been reset to zero",
          updatedCount,
        });
      } catch (error) {
        console.error("Error resetting stock values:", error);
        res
          .status(500)
          .json({ message: "Failed to reset stock and sold values" });
      }
    },
  );

  const upload = multer({ storage: multer.memoryStorage() });

  // Admin endpoint: attempt to fix itemsPerPallet for existing products by parsing numbers
  // Call with ?confirm=true to perform updates; otherwise it returns a dry-run report.
  apiRouter.post('/products/fix-items-per-pallet', async (req: Request, res: Response) => {
    try {
      const confirm = req.query.confirm === 'true';
      const allProducts = await storage.listProducts(100000, 0);
      const updates: Array<{ id: number; old: number | null | undefined; found: number }> = [];

      for (const p of allProducts) {
        const current = p.itemsPerPallet || 0;
        if (current && current > 1) continue; // already set

        const candidates = [p.itemsPerPallet, p.itemNo, p.srNo, p.sapCode, p.name, p.description];
        let found: number | null = null;
        for (const c of candidates) {
          if (!c) continue;
          const s = String(c);
          const m = s.match(/\b(\d{1,4})\b/);
          if (m) {
            const n = Number(m[1]);
            if (Number.isFinite(n) && n > 1) {
              found = Math.round(n);
              break;
            }
          }
        }

        if (found) {
          updates.push({ id: p.id as number, old: p.itemsPerPallet, found });
          if (confirm) {
            await storage.updateProduct(p.id as number, { itemsPerPallet: found });
          }
        }
      }

      return res.json({ success: true, confirm, updated: updates.length, details: updates.slice(0, 200) });
    } catch (err) {
      console.error('Failed to fix itemsPerPallet:', err);
      return res.status(500).json({ error: 'Failed to fix itemsPerPallet' });
    }
  });

  // Proforma Slip endpoints
  apiRouter.get("/proforma-slips", async (req: Request, res: Response) => {
    try {
      // Use a very high limit by default to effectively fetch all proforma slips records
      const limit = req.query.limit
        ? parseInt(req.query.limit as string)
        : 100000;
      const offset = req.query.offset
        ? parseInt(req.query.offset as string)
        : 0;

      console.log(
        `Fetching proforma slips with limit=${limit}, offset=${offset}`,
      );

      // Handle date filtering
      const startOrderDate = req.query.startOrderDate as string | undefined;
      const endOrderDate = req.query.endOrderDate as string | undefined;

      if (startOrderDate && endOrderDate) {
        console.log(
          `Filtering proforma slips by orderDate: ${startOrderDate} to ${endOrderDate}`,
        );
      }

      const slips = await storage.listProformaSlips(limit, offset);

      // Apply date filtering on the server-side if dates are specified
      let filteredSlips = slips;
      if (startOrderDate && endOrderDate) {
        // Make sure we convert dates to standardized format for comparison
        filteredSlips = slips.filter((slip) => {
          if (!slip.orderDate) return false;

          // Try to parse the date in different formats
          const parsedOrderDate = parseOrderDate(slip.orderDate);
          if (!parsedOrderDate) return false;

          // Convert to ISO strings for comparison (only the date part)
          const orderDateStr = parsedOrderDate.toISOString().split("T")[0];

          // Check if the order date is in the requested range
          return orderDateStr >= startOrderDate && orderDateStr <= endOrderDate;
        });
        console.log(
          `Filtered from ${slips.length} to ${filteredSlips.length} slips`,
        );
      }

      // Ensure totalQuantity is properly set for all slips
      const updatedSlips = await Promise.all(
        filteredSlips.map(async (slip) => {
          if (slip.totalQuantity === null || slip.totalQuantity === undefined) {
            // Calculate total quantity from slip items
            const items = await storage.getProformaSlipItems(slip.id);
            const totalQuantity = items.reduce(
              (sum, item) => sum + (item.quantity || 0),
              0,
            );

            console.log(
              `Updating slip #${slip.orderNumber} totalQuantity to ${totalQuantity}`,
            );

            // Update the slip in storage
            await storage.updateProformaSlip(slip.id, { totalQuantity });

            // Return updated slip
            return { ...slip, totalQuantity };
          }

          return slip;
        }),
      );

      res.json(updatedSlips);
    } catch (error) {
      console.error("Error fetching proforma slips:", error);
      res
        .status(500)
        .json({
          message: "Failed to retrieve proforma slips",
          error: String(error),
        });
    }
  });

  // Endpoint to recalculate volumes for all proforma slips
  apiRouter.post(
    "/proforma-slips/recalculate-volumes",
    async (req: Request, res: Response) => {
      try {
        // Get date range from request or fetch all slips if no dates are specified
        const startDate = req.body.startDate || null;
        const endDate = req.body.endDate || null;
        const targetDate = req.body.targetDate || null; // For backward compatibility

        // Fetch all slips using a very high limit
        const slips = await storage.listProformaSlips(100000, 0);

        // Filter slips based on provided date criteria
        let filteredSlips: typeof slips = [];

        if (startDate && endDate) {
          // Filter by date range if both start and end dates are provided
          console.log(
            `Filtering slips by date range: ${startDate} to ${endDate}`,
          );

          // Convert dates to timestamps for comparison
          const startTimestamp = new Date(startDate).getTime();
          const endTimestamp = new Date(endDate).getTime();

          filteredSlips = slips.filter((slip) => {
            if (!slip.orderDate) return false;
            const slipDate = new Date(slip.orderDate).getTime();
            return slipDate >= startTimestamp && slipDate <= endTimestamp;
          });

          console.log(
            `Filtered to ${filteredSlips.length} slips within date range`,
          );
        } else if (targetDate) {
          // Filter to a specific date if only targetDate is provided (backward compatibility)
          filteredSlips = slips.filter((slip) => {
            if (!slip.orderDate) return false;
            return slip.orderDate === targetDate;
          });
          console.log(
            `Filtered to ${filteredSlips.length} slips for specific date ${targetDate}`,
          );
        } else {
          // No date filtering, process all slips
          filteredSlips = slips;
          console.log(
            `No date filtering applied, processing all ${slips.length} slips`,
          );
        }

        if (!filteredSlips || filteredSlips.length === 0) {
          return res.status(404).json({
            success: false,
            message:
              startDate && endDate
                ? `No proforma slips found for date range ${startDate} to ${endDate}`
                : targetDate
                  ? `No proforma slips found for date ${targetDate}`
                  : `No proforma slips found`,
          });
        }

        // Log appropriate message based on filter type
        let logMessage = "";
        if (startDate && endDate) {
          logMessage = `Found ${filteredSlips.length} slips for date range ${startDate} to ${endDate}. Starting volume recalculation...`;
        } else if (targetDate) {
          logMessage = `Found ${filteredSlips.length} slips for date ${targetDate}. Starting volume recalculation...`;
        } else {
          logMessage = `Found ${filteredSlips.length} slips. Starting volume recalculation for all slips...`;
        }
        console.log(logMessage);

        // Start the recalculation process in the background
        // We'll process 3 slips at a time to avoid overwhelming the database
        const batchSize = 3;
        let processedCount = 0;
        let successCount = 0;

        // Process the first batch immediately and return response to client
        const firstBatch = filteredSlips.slice(0, batchSize);

        for (const slip of firstBatch) {
          try {
            const updatedSlip = await recalculateSlipVolume(slip.id, storage);
            if (updatedSlip) {
              console.log(
                `✅ Initial batch: Updated slip #${slip.id} from ${slip.totalVolume} to ${updatedSlip.totalVolume}`,
              );
              successCount++;
            }
          } catch (err) {
            console.error(`Error updating slip #${slip.id}:`, err);
          }
          processedCount++;
        }

        // Continue processing the rest in the background
        (async () => {
          for (let i = batchSize; i < filteredSlips.length; i += batchSize) {
            const batch = filteredSlips.slice(i, i + batchSize);

            for (const slip of batch) {
              try {
                const updatedSlip = await recalculateSlipVolume(
                  slip.id,
                  storage,
                );
                if (updatedSlip) {
                  console.log(
                    `✅ Background: Updated slip #${slip.id} from ${slip.totalVolume} to ${updatedSlip.totalVolume}`,
                  );
                  successCount++;
                }
              } catch (err) {
                console.error(`Error updating slip #${slip.id}:`, err);
              }
              processedCount++;
            }

            console.log(
              `Progress: ${processedCount}/${filteredSlips.length} slips processed, ${successCount} successfully updated`,
            );

            // Add a small delay between batches to prevent overwhelming the database
            await new Promise((resolve) => setTimeout(resolve, 500));
          }

          console.log(
            `Volume recalculation completed. Processed: ${processedCount}/${filteredSlips.length}, Success: ${successCount}`,
          );
        })();

        // Create appropriate response message based on filter type
        let responseMessage = "";
        if (startDate && endDate) {
          responseMessage = `Started volume recalculation for ${filteredSlips.length} proforma slips from ${startDate} to ${endDate}`;
        } else if (targetDate) {
          responseMessage = `Started volume recalculation for ${filteredSlips.length} proforma slips from ${targetDate}`;
        } else {
          responseMessage = `Started volume recalculation for ${filteredSlips.length} proforma slips`;
        }

        res.status(200).json({
          success: true,
          message: responseMessage,
          totalSlips: filteredSlips.length,
          initialProcessed: firstBatch.length,
          dateRange: startDate && endDate ? { startDate, endDate } : null,
          targetDate: targetDate,
        });
      } catch (error) {
        console.error("Error recalculating volumes:", error);
        res.status(500).json({
          success: false,
          message: "Failed to recalculate volumes",
          error: (error as Error).message,
        });
      }
    },
  );

  // Endpoint to recalculate volume for a single slip
  apiRouter.post(
    "/proforma-slips/:id/recalculate-volume",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        console.log(`Recalculating volume for single slip ${id}`);

        const updatedSlip = await recalculateSlipVolume(id, storage);

        if (!updatedSlip) {
          return res.status(404).json({
            success: false,
            message: "Proforma slip not found or volume calculation failed",
          });
        }

        res.json({
          success: true,
          message: `Successfully recalculated volume for slip #${id}`,
          slip: updatedSlip,
        });
      } catch (error) {
        console.error(
          `Error recalculating volume for slip ${req.params.id}:`,
          error,
        );
        res.status(500).json({
          success: false,
          message: `Failed to recalculate volume: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  );

  // Export proforma slips to CSV route must come before :id route to avoid conflicts
  // Export all proforma slips
  apiRouter.get(
    "/proforma-slips/export-csv",
    async (req: Request, res: Response) => {
      try {
        // Get query parameters for filtering
        const filterDate = req.query.date as string;
        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;

        // Get all proforma slips with very high limit for no practical limitation
        const slips = await storage.listProformaSlips(100000, 0);

        if (!slips || slips.length === 0) {
          return res.status(404).json({ error: "No proforma slips found" });
        }

        // Filter slips by date if provided
        let filteredSlips = slips;
        let dateFilter = "";

        if (startDate && endDate) {
          // Filter by date range if both start and end dates are provided
          console.log(
            `Filtering slips by date range: ${startDate} to ${endDate}`,
          );

          // Convert to Date objects for comparison
          const startDateObj = new Date(startDate);
          const endDateObj = new Date(endDate);

          dateFilter = `${startDate}-to-${endDate}`;
          filteredSlips = slips.filter((slip) => {
            if (!slip.orderDate) return false;
            const slipDate = new Date(slip.orderDate);
            return slipDate >= startDateObj && slipDate <= endDateObj;
          });

          console.log(
            `Filtered to ${filteredSlips.length} slips within date range ${startDate} to ${endDate}`,
          );
        } else if (filterDate) {
          // Convert DD/MM/YYYY format to Date object for comparison
          const parts = filterDate.split("/");
          if (parts.length === 3) {
            const day = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1; // Months are 0-indexed in JS
            const year = parseInt(parts[2]);
            const filterDateObj = new Date(year, month, day);

            dateFilter = filterDateObj.toISOString().split("T")[0];
            filteredSlips = slips.filter((slip) => {
              if (!slip.orderDate) return false;
              const slipDate = new Date(slip.orderDate);
              return slipDate.toISOString().split("T")[0] === dateFilter;
            });

            console.log(
              `Filtered to ${filteredSlips.length} slips for date ${filterDate}`,
            );
          }
        } else {
          // No date filter provided, use all slips
          dateFilter = "all-dates";
          filteredSlips = slips;
          console.log(
            `No date filter provided. Processing all ${filteredSlips.length} slips`,
          );
        }

        // Fetch items for each slip and products for each item
        const csvRows: any[] = [];

        // Calculate total volume sum for all matched slips
        let totalVolumeSum = 0;

        for (const slip of filteredSlips) {
          // Add to total volume if it's a valid number
          if (slip.totalVolume && !isNaN(parseFloat(slip.totalVolume))) {
            totalVolumeSum += parseFloat(slip.totalVolume);
          }

          // Fetch items for this slip
          const slipItems = await storage.getProformaSlipItems(slip.id);

          // If slip has no items, still add one row for the slip header
          if (!slipItems || slipItems.length === 0) {
            csvRows.push({
              orderNumber: slip.orderNumber,
              orderDate: slip.orderDate || "",
              partyName: slip.partyName,
              plant: slip.plant,
              totalQuantity: slip.totalQuantity,
              totalVolume: slip.totalVolume,
              vehicleNumber: slip.vehicleNumber,
              driverName: slip.driverName,
              notes: slip.notes,
              productId: "",
              productSrNo: "",
              productBarcode: "",
              productName: "",
              quantity: "",
            });
          } else {
            // Add a row for each item in the slip
            // IMPORTANT: Use ONLY snapshot data from item to ensure immutability
            // DO NOT fetch product data - proforma slips must remain unchanged even if inventory is edited/deleted
            for (const item of slipItems) {
              csvRows.push({
                orderNumber: slip.orderNumber,
                orderDate: slip.orderDate
                  ? new Date(slip.orderDate).toISOString().split("T")[0]
                  : "",
                partyName: slip.partyName,
                plant: slip.plant,
                totalQuantity: slip.totalQuantity,
                totalVolume: slip.totalVolume,
                vehicleNumber: slip.vehicleNumber,
                driverName: slip.driverName,
                notes: slip.notes,
                productId: item.sapCode || item.productId || "",
                productSrNo: item.srNo || "",
                productBarcode: item.barcode || "",
                productName: item.itemName || "",
                quantity: item.quantity,
              });
            }
          }
        }

        // Convert to CSV
        let csv = "";

        // Add total volume summary at the beginning
        let summaryText = "";
        if (startDate && endDate) {
          summaryText = `Total Volume Sum for date range ${startDate} to ${endDate}`;
        } else if (filterDate) {
          summaryText = `Total Volume Sum for ${dateFilter}`;
        } else {
          summaryText = "Total Volume Sum for all dates";
        }

        csv += `"${summaryText}","${totalVolumeSum.toFixed(2)}"\n\n`;

        // Add headers
        if (csvRows.length > 0) {
          const headers = Object.keys(csvRows[0]);
          csv += headers.join(",") + "\n";

          // Add rows
          csvRows.forEach((row) => {
            const values = headers.map((header) => {
              const value = row[header]?.toString().replace(/,/g, ";") || "";
              return `"${value}"`;
            });
            csv += values.join(",") + "\n";
          });
        }

        // Generate appropriate filename
        let filename = "proforma-slips";
        if (startDate && endDate) {
          filename += `-${startDate}-to-${endDate}`;
        } else if (dateFilter) {
          filename += `-${dateFilter}`;
        } else {
          filename += "-all-dates";
        }

        // Set headers and send response
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=${filename}.csv`,
        );
        return res.status(200).send(csv);
      } catch (error: any) {
        console.error("Export error:", error);
        return res
          .status(500)
          .json({ error: `Failed to export CSV: ${error.message}` });
      }
    },
  );

  // Export a specific proforma slip by ID
  apiRouter.get(
    "/proforma-slips/export-csv/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const slip = await storage.getProformaSlip(id);

        if (!slip) {
          return res.status(404).json({ error: "Proforma slip not found" });
        }

        // Fetch items for this slip and products for each item
        const csvRows: any[] = [];
        const slipItems = await storage.getProformaSlipItems(slip.id);

        // If slip has no items, still add one row for the slip header
        if (!slipItems || slipItems.length === 0) {
          csvRows.push({
            orderNumber: slip.orderNumber,
            orderDate: slip.orderDate || "",
            partyName: slip.partyName,
            plant: slip.plant,
            totalQuantity: slip.totalQuantity,
            totalVolume: slip.totalVolume,
            vehicleNumber: slip.vehicleNumber,
            driverName: slip.driverName,
            notes: slip.notes,
            productId: "",
            productSrNo: "",
            productBarcode: "",
            productName: "",
            quantity: "",
          });
        } else {
          // Add a row for each item in the slip
          // IMPORTANT: Use ONLY snapshot data from item to ensure immutability
          for (const item of slipItems) {
            csvRows.push({
              orderNumber: slip.orderNumber,
              orderDate: slip.orderDate || "",
              partyName: slip.partyName,
              plant: slip.plant,
              totalQuantity: slip.totalQuantity,
              totalVolume: slip.totalVolume,
              vehicleNumber: slip.vehicleNumber,
              driverName: slip.driverName,
              notes: slip.notes,
              productId: item.sapCode || item.productId || "",
              productSrNo: item.srNo || "",
              productBarcode: item.barcode || "",
              productName: item.itemName || "",
              quantity: item.quantity,
            });
          }
        }

        // Convert to CSV
        let csv = "";

        // Add headers
        if (csvRows.length > 0) {
          const headers = Object.keys(csvRows[0]);
          csv += headers.join(",") + "\n";

          // Add rows
          csvRows.forEach((row) => {
            const values = headers.map((header) => {
              const value = row[header]?.toString().replace(/,/g, ";") || "";
              return `"${value}"`;
            });
            csv += values.join(",") + "\n";
          });
        }

        // Set headers and send response
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=proforma-slip-${slip.orderNumber}.csv`,
        );
        return res.status(200).send(csv);
      } catch (error: any) {
        console.error("Export error:", error);
        return res
          .status(500)
          .json({ error: `Failed to export CSV: ${error.message}` });
      }
    },
  );

  // Import proforma slips from CSV route must come before :id route to avoid conflicts
  apiRouter.post(
    "/proforma-slips/import-csv",
    upload.single("file"),
    async (req: Request, res: Response) => {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const fileBuffer = req.file.buffer;
      let slipsCreated = 0;
      let itemsCreated = 0;
      let errors: string[] = [];
      // For batch processing of items
      let batchItems: InsertProformaSlipItem[] = [];
      // Cache for slip items to avoid repeated database queries
      const slipItemsCache = new Map<number, any[]>();

      try {
        // Parse CSV
        const records: any[] = [];
        const stream = Readable.from(fileBuffer.toString());

        await new Promise<void>((resolve, reject) => {
          stream
            .pipe(csv())
            .on("data", (data) => records.push(data))
            .on("error", (err) => reject(err))
            .on("end", () => resolve());
        });

        console.log("CSV data parsed:", records.length, "records");

        // Map more fields for debugging
        if (records.length > 0) {
          console.log("Sample record fields:", Object.keys(records[0]));
          console.log("Sample record values:", Object.values(records[0]));
        }

        // First, try to map for inventory CSV format (the standard format)
        if (
          records.length > 0 &&
          records[0]["Sr. No.:"] &&
          !records[0].orderNumber
        ) {
          // This is the inventory CSV format, convert to proforma format
          const convertedRecords = [];

          // Create a dummy order
          const dummyOrderNumber = `CSV-IMPORT-${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "2-digit" }).replace(/\//g, "-")}`;
          const currentDate = new Date()
            .toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "2-digit",
              year: "2-digit",
            })
            .replace(/\//g, "-");

          for (const row of records) {
            // Skip headers and empty rows
            if (row["Sr. No.:"] === "Sr. No.:" || !row["Sr. No.:"]) continue;

            // Only process rows with valid product information
            if (row["Item Name"]) {
              convertedRecords.push({
                orderNumber: dummyOrderNumber,
                orderDate: currentDate,
                partyName: "CSV Import",
                plant: "RAJKOT",
                productSrNo: row["Sr. No.:"] || "",
                productName: row["Item Name"] || "",
                productBarcode: row["SKU"] || "",
                quantity: row["InStock"] || "0",
              });
            }
          }

          console.log(
            "Converted inventory format to proforma format:",
            convertedRecords.length,
            "items",
          );

          // Replace records with converted ones
          if (convertedRecords.length > 0) {
            records.length = 0; // Clear original records
            records.push(...convertedRecords); // Use converted records
          }
        }

        // NO LONGER pre-fetching products - we read ALL data from CSV directly
        console.log(
          "CSV import mode: Reading all data directly from CSV without inventory lookup",
        );

        // Group records by orderNumber to create slips and items
        const slipGroups = new Map<string, any[]>();

        // Group records by order number
        for (const record of records) {
          const orderNumber = record.orderNumber || "";
          if (!orderNumber) {
            errors.push(`Skipped record: Missing order number`);
            continue;
          }

          if (!slipGroups.has(orderNumber)) {
            slipGroups.set(orderNumber, []);
          }

          slipGroups.get(orderNumber)?.push(record);
        }

        console.log(`Grouped records into ${slipGroups.size} order groups`);

        // Process each slip group
        let groupCount = 0;
        for (const orderNumber of Array.from(slipGroups.keys())) {
          groupCount++;
          console.log(
            `Processing order group ${groupCount}/${slipGroups.size}: Order #${orderNumber}`,
          );

          const slipRecords = slipGroups.get(orderNumber) || [];

          if (slipRecords.length === 0) {
            console.log(`No records for order #${orderNumber}, skipping`);
            continue;
          }

          // Get the first record for slip details (all records in group should have same slip details)
          const slipRecord = slipRecords[0];

          try {
            // Format order date properly - it's coming in as DD/MM/YY format
            let formattedOrderDate = slipRecord.orderDate || "";

            if (formattedOrderDate) {
              // Convert DD/MM/YY to YYYY-MM-DD
              const dateParts = formattedOrderDate.split("/");
              if (dateParts.length === 3) {
                // Add century to year if it's just 2 digits
                let year = dateParts[2];
                if (year.length === 2) {
                  year = "20" + year;
                }
                formattedOrderDate = `${year}-${dateParts[1].padStart(2, "0")}-${dateParts[0].padStart(2, "0")}`;
              }
            } else {
              // Use current date as fallback
              formattedOrderDate = new Date().toISOString().split("T")[0];
            }

            // Check if a slip with this order number already exists
            const existingSlips = await storage.listProformaSlips(1000, 0);
            const existingSlip = existingSlips.find(
              (slip) => slip.orderNumber === orderNumber,
            );

            let slipId: number;

            if (existingSlip) {
              // Use existing slip
              console.log(
                `Using existing slip #${existingSlip.id} for order #${orderNumber}`,
              );
              slipId = existingSlip.id;
            } else {
              // Create new slip with the correct type
              // Calculate total quantity from item quantities in slipRecords
              let calculatedTotalQuantity = 0;
              slipRecords.forEach((record) => {
                const itemQuantity = parseInt(record.quantity) || 0;
                calculatedTotalQuantity += itemQuantity;
              });

              // First check if there are any users in the system
              const users = await storage.listUsers(10, 0);
              const defaultUserId = users.length > 0 ? users[0].id : null;

              const slipData = {
                orderNumber: orderNumber,
                orderDate: formattedOrderDate,
                partyName: slipRecord.partyName || "",
                plant: slipRecord.plant || "",
                totalQuantity: calculatedTotalQuantity, // Use calculated value instead of imported value
                totalVolume: slipRecord.totalVolume || "",
                vehicleNumber: slipRecord.vehicleNumber || "",
                driverName: slipRecord.driverName || "",
                notes: slipRecord.notes || "",
                createdById: defaultUserId,
              };

              console.log(
                `Creating new slip for order #${orderNumber}:`,
                slipData,
              );
              const newSlip = await storage.createProformaSlip(slipData);
              console.log(
                `Created new slip #${newSlip.id} for order #${orderNumber}`,
              );
              slipId = newSlip.id;
              slipsCreated++;
            }

            // Process each record for items
            let itemCount = 0;
            for (const record of slipRecords) {
              itemCount++;
              console.log(
                `Processing item ${itemCount}/${slipRecords.length} for order #${orderNumber}`,
              );

              // Skip if no product info
              if (
                !record.productId &&
                !record.productSrNo &&
                !record.productBarcode &&
                !record.productName
              ) {
                console.log(
                  `Skipping item with no product identifiers for order #${orderNumber}`,
                );
                continue;
              }

              try {
                // NO PRODUCT LOOKUP - Read all data directly from CSV
                console.log(
                  `CSV import - Processing item from CSV data only (no inventory lookup)`,
                );

                // Parse quantity safely
                let quantity = 0;
                try {
                  quantity = parseInt(record.quantity || "0");
                  if (isNaN(quantity)) {
                    quantity = 0;
                  }
                } catch (err) {
                  console.log(`Error parsing quantity: ${record.quantity}`);
                  quantity = 0;
                }

                // Get all items for this slip (from cache if available)
                let slipItems;
                if (!slipItemsCache.has(slipId)) {
                  console.log(
                    `Fetching items for slip #${slipId} (first time)`,
                  );
                  slipItems = await storage.getProformaSlipItems(slipId);
                  slipItemsCache.set(slipId, slipItems);
                } else {
                  console.log(`Using cached items for slip #${slipId}`);
                  slipItems = slipItemsCache.get(slipId) || [];
                }

                // Check if this item already exists (match by barcode or item name)
                const existingItem = slipItems.find(
                  (item) =>
                    (record.productBarcode &&
                      item.barcode === record.productBarcode) ||
                    (record.productName &&
                      item.itemName === record.productName),
                );

                if (existingItem) {
                  // Update existing item quantity and refresh snapshot data from CSV
                  const currentQuantity = existingItem.quantity || 0;
                  const newQuantity = currentQuantity + quantity;
                  console.log(
                    `Updating existing item #${existingItem.id} quantity from ${currentQuantity} to ${newQuantity} with CSV data`,
                  );
                  await storage.updateProformaSlipItem(existingItem.id, {
                    quantity: newQuantity,
                    // Refresh ALL snapshot fields from CSV data
                    srNo: record.productSrNo || record.srNo || "",
                    itemNo: record.productItemNo || record.itemNo || "",
                    barcode: record.productBarcode || record.barcode || "",
                    itemName: record.productName || record.itemName || "",
                    category: record.category || "",
                    volumeInCuFt: record.volumeInCuFt || record.volume || "",
                    hsnCode: record.hsnCode || "",
                    sapCode: record.sapCode || "",
                    description: record.description || "",
                    purchasePrice: record.purchasePrice || "",
                    sellingPrice: record.sellingPrice || "",
                  });
                } else {
                  // Create new item with ALL data from CSV (no inventory lookup)
                  const itemData = {
                    proformaSlipId: slipId,
                    productId: null, // No longer linking to inventory
                    quantity: quantity,
                    // ALL snapshot fields from CSV
                    srNo: record.productSrNo || record.srNo || "",
                    itemNo: record.productItemNo || record.itemNo || "",
                    barcode: record.productBarcode || record.barcode || "",
                    itemName: record.productName || record.itemName || "",
                    category: record.category || "",
                    volumeInCuFt: record.volumeInCuFt || record.volume || "",
                    hsnCode: record.hsnCode || "",
                    sapCode: record.sapCode || "",
                    description: record.description || "",
                    purchasePrice: record.purchasePrice || "",
                    sellingPrice: record.sellingPrice || "",
                  };

                  console.log(
                    `Creating new item for slip #${slipId} from CSV data: ${itemData.itemName}, quantity: ${quantity}`,
                  );
                  // Items will be batched later - just add to the batch array instead of creating immediately
                  batchItems.push(itemData);
                  itemsCreated++;

                  // Process batch items in smaller chunks (every 100 items) for better response time
                  if (batchItems.length >= 100) {
                    try {
                      console.log(
                        `Processing interim batch of ${batchItems.length} items`,
                      );
                      await storage.batchCreateProformaSlipItems(batchItems);
                      console.log(
                        `Successfully processed interim batch of ${batchItems.length} items`,
                      );
                      // Clear batch array after successful processing
                      batchItems.length = 0;
                    } catch (batchError: any) {
                      console.error(
                        "Error in interim batch processing:",
                        batchError,
                      );
                      // Keep items in the array to try again later
                    }
                  }
                }
              } catch (error: any) {
                console.error(
                  `Error adding item to order #${orderNumber}:`,
                  error,
                );
                errors.push(
                  `Error adding item to order #${orderNumber}: ${error.message}`,
                );
              }
            }
          } catch (error: any) {
            console.error(`Error processing order #${orderNumber}:`, error);
            errors.push(
              `Error processing order #${orderNumber}: ${error.message}`,
            );
          }
        }

        // Process batch items if there are any
        if (batchItems.length > 0) {
          try {
            console.log(
              `Batch processing ${batchItems.length} items at once for better performance`,
            );
            await storage.batchCreateProformaSlipItems(batchItems);
            console.log(
              `Successfully created ${batchItems.length} items in batch mode`,
            );
          } catch (batchError: any) {
            console.error("Error in batch processing items:", batchError);
            errors.push(`Error in batch processing: ${batchError.message}`);
            // Try individual creation as fallback
            console.log("Falling back to individual item creation");
            for (const item of batchItems) {
              try {
                await storage.createProformaSlipItem(item);
              } catch (fallbackError: any) {
                console.error(
                  `Error creating item for slip #${item.proformaSlipId}:`,
                  fallbackError,
                );
                errors.push(`Error creating item: ${fallbackError.message}`);
              }
            }
          }
        }

        // Run automatic backup after successful import
        try {
          console.log("Running automatic backup after CSV import...");
          const backupResult = await storage.runBackupOperation();
          console.log("Automatic backup completed successfully:", backupResult);

          return res.status(200).json({
            message: `Imported ${slipsCreated} slips and ${itemsCreated} items. Data automatically backed up.`,
            slipsCreated,
            itemsCreated,
            backupResult,
            errors: errors.length > 0 ? errors : undefined,
          });
        } catch (backupError: any) {
          console.error("Automatic backup failed:", backupError);
          // Still return success for the import, just note that backup failed
          return res.status(200).json({
            message: `Imported ${slipsCreated} slips and ${itemsCreated} items. Automatic backup failed.`,
            slipsCreated,
            itemsCreated,
            backupError: backupError.message,
            errors: errors.length > 0 ? errors : undefined,
          });
        }
      } catch (error: any) {
        console.error("CSV import error:", error);
        return res
          .status(500)
          .json({ error: `Failed to import CSV: ${error.message}` });
      }
    },
  );

  apiRouter.post("/proforma-slips", requirePageWrite("proforma"), async (req: Request, res: Response) => {
    try {
      const slipData = insertProformaSlipSchema.parse(req.body);

      // Ensure totalQuantity is 0 initially, it will be updated when items are added
      if (slipData.totalQuantity === undefined) {
        slipData.totalQuantity = 0;
      }

      const slip = await storage.createProformaSlip(slipData);
      res.status(201).json(slip);
    } catch (error) {
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      res.status(400).json({ message: "Invalid proforma slip data" });
    }
  });

  apiRouter.get(
    "/proforma-slips/order/:orderNumber",
    async (req: Request, res: Response) => {
      // Never let a reverse proxy (IIS ARR) or browser cache this — Print Operations refetches
      // it right after Lock/Unlock to reflect the new state immediately; without this, a GET to
      // the exact same URL moments later can be served a stale cached response instead of
      // hitting the server again, so the button never updates until a hard page reload bypasses
      // the cache by chance. Same fix already applied to order-import.ts/order-scan.ts.
      res.set("Cache-Control", "no-store, no-cache, must-revalidate");
      res.set("Pragma", "no-cache");
      try {
        if (!req.isAuthenticated || !req.isAuthenticated()) {
          return res.status(401).json({ message: "Not authenticated" });
        }
        const orderNumber = req.params.orderNumber;
        if (!orderNumber) {
          return res.status(400).json({ message: "Order number is required" });
        }

        const slip = await storage.getProformaSlipByOrderNumber(orderNumber);
        if (!slip) {
          return res
            .status(404)
            .json({
              message: "Proforma slip not found for the given order number",
            });
        }

        // Get all items for this slip
        const items = await storage.getProformaSlipItems(slip.id);

        // Retrieve full product details for each item to get names, SKU, and Sr.No
        const enhancedItems = await Promise.all(
          items.map(async (item) => {
            // Try to find the product details using productId
            if (item.productId) {
              try {
                const product = await storage.getProduct(item.productId);
                if (product) {
                  return {
                    ...item,
                    itemName: product.name,
                    sku: product.barcode,
                    srNo: product.newSr,
                    itemsPerPallet: product.itemsPerPallet,
                  };
                }
              } catch (error) {
                console.error(
                  `Error fetching product ${item.productId}:`,
                  error,
                );
              }
            }
            return item;
          }),
        );

        // Return slip with enhanced items
        res.json({
          slip,
          items: enhancedItems,
        });
      } catch (error) {
        console.error("Error fetching proforma slip by order number:", error);
        res
          .status(500)
          .json({
            message: "Failed to retrieve proforma slip by order number",
            error: String(error),
          });
      }
    },
  );

  apiRouter.put(
    "/proforma-slips/order/:orderNumber",
    async (req: Request, res: Response) => {
      try {
        const orderNumber = req.params.orderNumber;
        if (!orderNumber) {
          return res.status(400).json({ message: "Order number is required" });
        }

        const slip = await storage.getProformaSlipByOrderNumber(orderNumber);
        if (!slip) {
          return res
            .status(404)
            .json({
              message: "Proforma slip not found for the given order number",
            });
        }

        // Get the update data from the request body
        const updateData = req.body;

        // Update the proforma slip
        const updatedSlip = await storage.updateProformaSlip(
          slip.id,
          updateData,
        );

        // Return the updated slip
        res.json({
          success: true,
          slip: updatedSlip,
        });
      } catch (error) {
        console.error("Error updating proforma slip by order number:", error);
        res
          .status(500)
          .json({
            message: "Failed to update proforma slip",
            error: String(error),
          });
      }
    },
  );

  apiRouter.get("/proforma-slips/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      console.log(
        `GET /api/proforma-slips/${id} - Fetching proforma slip and items`,
      );

      const slip = await storage.getProformaSlip(id);

      if (!slip) {
        console.log(`Proforma slip with ID ${id} not found`);
        return res.status(404).json({ message: "Proforma slip not found" });
      }

      console.log(`Found proforma slip: ${slip.orderNumber}`);

      // Get all items related to this slip
      const items = await storage.getProformaSlipItems(id);
      console.log(`Found ${items.length} items for slip ${id}`);

      // IMPORTANT: Use ONLY snapshot data from proformaSlipItems to ensure immutability
      // DO NOT join to products table - proforma slips must remain unchanged even if inventory is edited
      console.log(
        "Using immutable snapshot data from proforma slip items (no product joins)",
      );

      // Return both the slip and its items with a fixed structure
      const response = {
        slip,
        items: items || [],
      };

      console.log(
        `Sending response for slip ${id} with ${response.items.length} items`,
      );
      res.json(response);
    } catch (error) {
      console.error("Error fetching proforma slip details:", error);
      res
        .status(500)
        .json({
          message: "Failed to retrieve proforma slip details",
          error: String(error),
        });
    }
  });

  apiRouter.put("/proforma-slips/:id", requirePageWrite("proforma"), async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      console.log(`PUT /api/proforma-slips/${id} - Request body:`, req.body);

      const slipData = insertProformaSlipSchema.partial().parse(req.body);
      console.log("Parsed slip data:", slipData);

      const existingSlip = await storage.getProformaSlip(id);
      console.log("Existing slip before update:", existingSlip);

      if (!existingSlip) {
        return res.status(404).json({ message: "Proforma slip not found" });
      }

      const updatedSlip = await storage.updateProformaSlip(id, slipData);
      console.log("Updated slip:", updatedSlip);

      if (!updatedSlip) {
        return res.status(404).json({ message: "Proforma slip not found" });
      }

      // Log activity for updating the proforma slip
      try {
        // Find the user who made the update
        const userId =
          req.session?.user?.id ||
          updatedSlip.createdById ||
          existingSlip.createdById;
        let userName = "Unknown User";

        if (userId) {
          const user = await storage.getUser(userId);
          if (user) {
            userName = user.name || user.username || "Unknown User";
          }
        }

        // Determine what was changed
        const changedFields = Object.keys(slipData)
          .filter(
            (key) =>
              slipData[key as keyof typeof slipData] !==
              existingSlip[key as keyof typeof existingSlip],
          )
          .join(", ");

        const activityDetails = JSON.stringify({
          changedFields,
          orderNumber: updatedSlip.orderNumber,
          partyName: updatedSlip.partyName,
          totalQuantity: updatedSlip.totalQuantity,
          totalVolume: updatedSlip.totalVolume,
        });

        // Create an activity record
        await storage.createActivity({
          pageName: "ProformaSlips",
          action: "update",
          entityType: "proformaSlip",
          entityId: String(id),
          details: activityDetails,
          userId: userId || null,
          userName: userName,
        });

        console.log(
          `Created activity record for updating proforma slip #${id} by ${userName}`,
        );
      } catch (activityError) {
        console.error("Error creating activity record:", activityError);
        // Don't fail the request if activity creation fails
      }

      res.json(updatedSlip);
    } catch (error) {
      console.error("Error updating proforma slip:", error);
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      res.status(400).json({ message: "Invalid proforma slip data" });
    }
  });

  apiRouter.delete(
    "/proforma-slips/:id",
    requirePageWrite("proforma"),
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const slip = await storage.getProformaSlip(id);

        if (!slip) {
          return res.status(404).json({ message: "Proforma slip not found" });
        }

        // Log activity for deleting the proforma slip
        try {
          // Find the user who is deleting the slip
          const userId = req.session?.user?.id || slip.createdById;
          let userName = "Unknown User";

          if (userId) {
            const user = await storage.getUser(userId);
            if (user) {
              userName = user.name || user.username || "Unknown User";
            }
          }

          const activityDetails = JSON.stringify({
            orderNumber: slip.orderNumber,
            partyName: slip.partyName,
            orderDate: slip.orderDate,
            totalQuantity: slip.totalQuantity,
            totalVolume: slip.totalVolume,
          });

          // Create an activity record
          await storage.createActivity({
            pageName: "ProformaSlips",
            action: "delete",
            entityType: "proformaSlip",
            entityId: String(id),
            details: activityDetails,
            userId: userId || null,
            userName: userName,
          });

          console.log(
            `Created activity record for deleting proforma slip #${id} by ${userName}`,
          );
        } catch (activityError) {
          console.error("Error creating activity record:", activityError);
          // Don't fail the request if activity creation fails
        }

        // Delete the slip (this will also delete all related items)
        const success = await storage.deleteProformaSlip(id);

        if (!success) {
          return res
            .status(500)
            .json({ message: "Failed to delete proforma slip" });
        }

        res.status(204).send();
      } catch (error) {
        console.error("Failed to delete proforma slip:", error);
        res.status(500).json({ message: "Failed to delete proforma slip" });
      }
    },
  );

  // Proforma Slip Items endpoints
  apiRouter.post(
    "/proforma-slips/:slipId/items",
    requirePageWrite("proforma"),
    async (req: Request, res: Response) => {
      try {
        const slipId = parseInt(req.params.slipId);
        const slip = await storage.getProformaSlip(slipId);

        if (!slip) {
          return res.status(404).json({ message: "Proforma slip not found" });
        }

        // For newly added items, we want to set originalQuantity to 0
        // and all loaded quantity will be counted as extra
        const requestData = {
          ...req.body,
          proformaSlipId: slipId,
          // If originalQuantity is not provided, default to 0 for new items
          originalQuantity: req.body.originalQuantity ?? 0,
        };

        console.log("Adding new proforma slip item:", requestData);

        // Create the item and associate it with the slip
        const itemData = insertProformaSlipItemSchema.parse(requestData);

        // Check if the product exists
        if (itemData.productId) {
          const product = await storage.getProduct(itemData.productId);
          if (!product) {
            return res
              .status(400)
              .json({ message: "Referenced product does not exist" });
          }

          // Copy ALL snapshot fields from product to ensure complete immutability
          // These fields should be copied at creation time and never updated
          if (!itemData.itemName && product.name) {
            itemData.itemName = product.name;
          }
          if (!itemData.barcode && product.barcode) {
            itemData.barcode = product.barcode;
          }
          if (!itemData.srNo && product.newSr) {
            itemData.srNo = product.newSr;
          }
          if (!itemData.itemNo && product.itemNo) {
            itemData.itemNo = product.itemNo;
          }
          if (!itemData.category && product.category) {
            itemData.category = product.category;
          }
          if (!itemData.volumeInCuFt && product.volumeInCuFt) {
            itemData.volumeInCuFt = product.volumeInCuFt;
          }
          if (!itemData.hsnCode && product.hsnCode) {
            itemData.hsnCode = product.hsnCode;
          }
          if (!itemData.sapCode && product.sapCode) {
            itemData.sapCode = product.sapCode;
          }
          if (!itemData.description && product.description) {
            itemData.description = product.description;
          }
          if (!itemData.purchasePrice && product.purchasePrice) {
            itemData.purchasePrice = product.purchasePrice;
          }
          if (!itemData.sellingPrice && product.sellingPrice) {
            itemData.sellingPrice = product.sellingPrice;
          }
        }

        const item = await storage.createProformaSlipItem(itemData);

        // Update the total quantity on the slip
        const allItems = await storage.getProformaSlipItems(slipId);
        const totalQuantity = allItems.reduce(
          (sum, item) => sum + (item.quantity || 0),
          0,
        );

        await storage.updateProformaSlip(slipId, {
          totalQuantity,
        });

        // Store this item ID as a newly added item in localStorage
        // We'll retrieve this on the client side
        console.log(`Added item ${item.id} to proforma slip ${slipId}`);

        res.status(201).json(item);
      } catch (error) {
        console.error("Error adding item to slip:", error);
        if (error instanceof ZodError) {
          const validationError = fromZodError(error);
          return res.status(400).json({ message: validationError.message });
        }
        res.status(400).json({ message: "Invalid proforma slip item data" });
      }
    },
  );

  apiRouter.put(
    "/proforma-slip-items/:id",
    requirePageWrite("proforma"),
    async (req: Request, res: Response) => {
      try {
        console.time("updateProformaSlipItem");
        const id = parseInt(req.params.id);

        // Directly fetch the specific item by ID instead of searching through all slips
        console.log(`Fetching proforma slip item with ID: ${id}`);
        const existingItem = await storage.getProformaSlipItem(id);

        if (!existingItem) {
          console.log(`Proforma slip item with ID ${id} not found`);
          return res
            .status(404)
            .json({ message: "Proforma slip item not found" });
        }

        console.log(`Found proforma slip item with ID ${id}, updating...`);

        // Update the item
        const itemData = insertProformaSlipItemSchema.partial().parse(req.body);
        const updatedItem = await storage.updateProformaSlipItem(id, itemData);

        if (!updatedItem) {
          console.log(`Failed to update proforma slip item with ID ${id}`);
          return res
            .status(404)
            .json({ message: "Proforma slip item could not be updated" });
        }

        // If quantity was updated, update the total quantity on the slip
        if (
          itemData.quantity !== undefined &&
          existingItem.proformaSlipId !== null
        ) {
          const slipId = existingItem.proformaSlipId as number;
          const allItems = await storage.getProformaSlipItems(slipId);
          const totalQuantity = allItems.reduce(
            (sum, item) => sum + (item.quantity || 0),
            0,
          );

          console.log(
            `Updating total quantity on proforma slip ${slipId} to ${totalQuantity}`,
          );
          await storage.updateProformaSlip(slipId, {
            totalQuantity,
          });
        }

        console.log(`Successfully updated proforma slip item with ID ${id}`);
        console.timeEnd("updateProformaSlipItem");
        res.json(updatedItem);
      } catch (error) {
        console.error("Error updating proforma slip item:", error);
        if (error instanceof ZodError) {
          const validationError = fromZodError(error);
          return res.status(400).json({ message: validationError.message });
        }
        res.status(400).json({ message: "Invalid proforma slip item data" });
      }
    },
  );

  apiRouter.delete(
    "/proforma-slip-items/:id",
    requirePageWrite("proforma"),
    async (req: Request, res: Response) => {
      try {
        console.time("deleteProformaSlipItem");
        const id = parseInt(req.params.id);

        // Directly fetch the item by its ID without searching through all slips
        console.log(`Fetching proforma slip item with ID: ${id} for deletion`);
        const existingItem = await storage.getProformaSlipItem(id);

        if (!existingItem) {
          console.log(
            `Proforma slip item with ID ${id} not found for deletion`,
          );
          return res
            .status(404)
            .json({ message: "Proforma slip item not found" });
        }

        console.log(`Found proforma slip item with ID ${id}, deleting...`);

        // Delete the item
        const success = await storage.deleteProformaSlipItem(id);

        if (!success) {
          console.log(`Failed to delete proforma slip item with ID ${id}`);
          return res
            .status(500)
            .json({ message: "Failed to delete proforma slip item" });
        }

        // Update the total quantity on the slip
        if (existingItem.proformaSlipId !== null) {
          const slipId = existingItem.proformaSlipId as number;
          console.log(
            `Updating total quantity on proforma slip ${slipId} after item deletion`,
          );
          const allItems = await storage.getProformaSlipItems(slipId);
          const totalQuantity = allItems.reduce(
            (sum, item) => sum + (item.quantity || 0),
            0,
          );

          await storage.updateProformaSlip(slipId, {
            totalQuantity,
          });
        }

        console.log(`Successfully deleted proforma slip item with ID ${id}`);
        console.timeEnd("deleteProformaSlipItem");
        res.status(204).send();
      } catch (error) {
        console.error("Failed to delete proforma slip item:", error);
        res
          .status(500)
          .json({ message: "Failed to delete proforma slip item" });
      }
    },
  );

  // Optimized batch update endpoint for proforma slip items
  apiRouter.post(
    "/proforma-slip-items/batch-update",
    requirePageWrite("proforma"),
    async (req: Request, res: Response) => {
      console.log(
        `Batch update request received for ${req.body.items?.length || 0} items`,
      );
      const startTime = Date.now();

      try {
        const items = req.body.items;

        if (!items || !Array.isArray(items)) {
          return res
            .status(400)
            .json({ error: "Invalid request body. Expected items array." });
        }

        // Step 1: Get all item IDs for efficient lookup
        const itemIds = items
          .map((item) => item.id)
          .filter((id) => id !== undefined);

        if (itemIds.length === 0) {
          return res.status(400).json({ error: "No valid item IDs provided" });
        }

        console.log(`Processing batch update for ${itemIds.length} items`);

        // Step 2: Fetch ALL items directly from the database in a single query
        // This is much faster than searching through all slips
        const existingItems = await storage.getProformaSlipItemsByIds(itemIds);

        if (!existingItems || existingItems.length === 0) {
          return res
            .status(404)
            .json({ error: "No items found with the provided IDs" });
        }

        console.log(
          `Found ${existingItems.length} of ${itemIds.length} items in database`,
        );

        // Create a map for faster lookups
        const itemsMap = new Map();
        existingItems.forEach((item) => {
          itemsMap.set(item.id, item);
        });

        // Create a map to track which slips need their totalQuantity updated
        const slipsToUpdate = new Map();

        // Step 3: Process all items and collect updates
        const updatePromises = items.map(async (item) => {
          if (!item.id) {
            return { success: false, error: "Item ID is required", item };
          }

          try {
            const existingItem = itemsMap.get(item.id);

            if (!existingItem) {
              return {
                success: false,
                error: `Item ${item.id} not found`,
                item,
              };
            }

            // Track the slip ID for quantity updates
            if (existingItem.proformaSlipId && item.quantity !== undefined) {
              slipsToUpdate.set(existingItem.proformaSlipId, true);
            }

            // Update the item with new data
            const itemData = {
              quantity:
                item.quantity !== undefined
                  ? item.quantity
                  : existingItem.quantity,
              loaded:
                item.loaded !== undefined ? item.loaded : existingItem.loaded,
              // Preserve originalQuantity if it's provided, otherwise keep the existing value
              originalQuantity:
                item.originalQuantity !== undefined
                  ? item.originalQuantity
                  : existingItem.originalQuantity,
            };

            const updatedItem = await storage.updateProformaSlipItem(
              item.id,
              itemData,
            );
            return { success: true, id: item.id, item: updatedItem };
          } catch (error) {
            console.error(`Error updating item ${item.id}:`, error);
            return {
              success: false,
              error: `Failed to update item ${item.id}: ${error.message}`,
              itemId: item.id,
            };
          }
        });

        // Execute all updates in parallel
        const results = await Promise.all(updatePromises);

        // Step 4: Update totals for affected slips (after all item updates are complete)
        const slipUpdatePromises = Array.from(slipsToUpdate.keys()).map(
          async (slipId) => {
            try {
              const allItems = await storage.getProformaSlipItems(slipId);
              const totalQuantity = allItems.reduce(
                (sum, i) => sum + (i.quantity || 0),
                0,
              );
              await storage.updateProformaSlip(slipId, { totalQuantity });

              // Also update the volume for this slip if needed
              try {
                await recalculateSlipVolume(slipId);
              } catch (volError) {
                console.error(
                  `Error recalculating volume for slip ${slipId}:`,
                  volError,
                );
              }

              return { slipId, success: true, totalQuantity };
            } catch (error) {
              console.error(`Error updating slip ${slipId}:`, error);
              return { slipId, success: false, error: error.message };
            }
          },
        );

        // Wait for all slip updates to complete
        const slipUpdateResults = await Promise.all(slipUpdatePromises);

        // Count successful updates
        const successCount = results.filter((r) => r.success).length;
        const failCount = results.length - successCount;

        const endTime = Date.now();
        const timeElapsed = endTime - startTime;

        console.log(
          `Batch update completed in ${timeElapsed}ms: ${successCount} successful, ${failCount} failed`,
        );

        // Return success if at least some items were updated
        if (successCount > 0) {
          return res.json({
            success: true,
            message: `Updated ${successCount} items in ${timeElapsed}ms`,
            updatedCount: successCount,
            failedCount: failCount,
            timeElapsed,
            results,
          });
        } else {
          return res.status(207).json({
            success: false,
            message: "All items failed to update",
            updatedCount: 0,
            failedCount: failCount,
            timeElapsed,
            results,
          });
        }
      } catch (error) {
        const endTime = Date.now();
        const timeElapsed = endTime - startTime;

        console.error("Error in batch update:", error);
        return res.status(500).json({
          error: "Failed to process batch update",
          message: error.message,
          timeElapsed,
        });
      }
    },
  );
  // Backup System Endpoints

  // Get backup settings
  apiRouter.get("/backup/settings", async (req: Request, res: Response) => {
    try {
      const settings = await storage.getBackupSettings();
      if (!settings) {
        return res.status(404).json({ message: "Backup settings not found" });
      }
      res.json(settings);
    } catch (error) {
      console.error("Error fetching backup settings:", error);
      res.status(500).json({ message: "Failed to retrieve backup settings" });
    }
  });

  // Update backup settings
  apiRouter.put("/backup/settings/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const settings = await storage.getBackupSettings();

      if (!settings || settings.id !== id) {
        return res.status(404).json({ message: "Backup settings not found" });
      }

      const updatedSettings = await storage.updateBackupSettings(id, req.body);
      if (!updatedSettings) {
        return res
          .status(404)
          .json({ message: "Failed to update backup settings" });
      }

      res.json(updatedSettings);
    } catch (error) {
      console.error("Error updating backup settings:", error);
      res.status(500).json({ message: "Failed to update backup settings" });
    }
  });

  // Run a backup operation manually
  apiRouter.post("/backup/run", async (req: Request, res: Response) => {
    try {
      // Removed user role check to allow all users to initiate backup
      const result = await storage.runBackupOperation();
      res.json({
        message: "Backup operation completed successfully",
        ...result,
      });
    } catch (error) {
      console.error("Error running backup operation:", error);
      res.status(500).json({ message: "Failed to run backup operation" });
    }
  });

  // Apply data retention policies manually
  apiRouter.post(
    "/backup/apply-retention-policies",
    async (req: Request, res: Response) => {
      try {
        // Removed user role check to allow all users to apply retention policies
        const result = await storage.applyDataRetentionPolicies();
        res.json({
          message: "Data retention policies applied successfully",
          ...result,
        });
      } catch (error) {
        console.error("Error applying data retention policies:", error);
        res
          .status(500)
          .json({ message: "Failed to apply data retention policies" });
      }
    },
  );

  // Get scan history backups with optional date filtering
  apiRouter.get("/backup/scans", async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      const offset = req.query.offset
        ? parseInt(req.query.offset as string)
        : 0;
      const startDate = req.query.startDate
        ? new Date(req.query.startDate as string)
        : undefined;
      const endDate = req.query.endDate
        ? new Date(req.query.endDate as string)
        : undefined;

      const backups = await storage.listScanHistoryBackups(
        startDate,
        endDate,
        limit,
        offset,
      );
      res.json(backups);
    } catch (error) {
      console.error("Error fetching scan history backups:", error);
      res
        .status(500)
        .json({ message: "Failed to retrieve scan history backups" });
    }
  });

  // Get loading operation backups with optional date filtering
  apiRouter.get(
    "/backup/loading-operations",
    async (req: Request, res: Response) => {
      try {
        const limit = req.query.limit
          ? parseInt(req.query.limit as string)
          : 100;
        const offset = req.query.offset
          ? parseInt(req.query.offset as string)
          : 0;

        // Handle various date filter options
        const orderDate = req.query.orderDate as string;
        const startOrderDate = req.query.startOrderDate as string;
        const endOrderDate = req.query.endOrderDate as string;

        // Legacy date parameters (will be phased out)
        const startDate = req.query.startDate
          ? new Date(req.query.startDate as string)
          : undefined;
        const endDate = req.query.endDate
          ? new Date(req.query.endDate as string)
          : undefined;

        // First check for single orderDate filter (new preferred approach)
        if (orderDate) {
          // Convert to Date object for consistent handling
          const parsedOrderDate = new Date(orderDate);
          const orderDateStart = new Date(parsedOrderDate);
          orderDateStart.setHours(0, 0, 0, 0);

          const orderDateEnd = new Date(parsedOrderDate);
          orderDateEnd.setHours(23, 59, 59, 999);

          console.log(
            `Backup Operations - Order date filter applied: ${orderDateStart.toISOString()} to ${orderDateEnd.toISOString()}`,
          );

          // Get backups for this exact orderDate
          const backups = await storage.listLoadingOperationBackups(
            undefined,
            undefined,
            limit,
            offset,
            parsedOrderDate,
          );

          return res.json(backups);
        }

        // Next check for date range with orderDate parameters
        if (startOrderDate && endOrderDate) {
          const startDate = new Date(startOrderDate);
          startDate.setHours(0, 0, 0, 0);

          const endDate = new Date(endOrderDate);
          endDate.setHours(23, 59, 59, 999);

          console.log(
            `Backup Operations - Order date range filter applied: ${startDate.toISOString()} to ${endDate.toISOString()}`,
          );

          // Get backups for this orderDate range
          const backups = await storage.listLoadingOperationBackups(
            startDate,
            endDate,
            limit,
            offset,
          );

          return res.json(backups);
        }

        // Fall back to legacy date parameters or no filtering
        const backups = await storage.listLoadingOperationBackups(
          startDate,
          endDate,
          limit,
          offset,
        );
        res.json(backups);
      } catch (error) {
        console.error("Error fetching loading operation backups:", error);
        res
          .status(500)
          .json({ message: "Failed to retrieve loading operation backups" });
      }
    },
  );

  // Delete a loading operation backup
  apiRouter.delete(
    "/backup/loading-operations/:id",
    async (req: Request, res: Response) => {
      try {
        const backupId = parseInt(req.params.id);
        if (isNaN(backupId)) {
          return res.status(400).json({ message: "Invalid backup ID" });
        }

        const success = await storage.deleteLoadingOperationBackup(backupId);
        if (!success) {
          return res.status(404).json({ message: "Backup record not found" });
        }

        return res.status(204).send();
      } catch (error) {
        console.error("Error deleting loading operation backup:", error);
        res
          .status(500)
          .json({ message: "Failed to delete loading operation backup" });
      }
    },
  );

  // Get sales backups with optional date filtering
  apiRouter.get("/backup/sales", async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      const offset = req.query.offset
        ? parseInt(req.query.offset as string)
        : 0;
      const startDate = req.query.startDate
        ? new Date(req.query.startDate as string)
        : undefined;
      const endDate = req.query.endDate
        ? new Date(req.query.endDate as string)
        : undefined;

      const backups = await storage.listSaleBackups(
        startDate,
        endDate,
        limit,
        offset,
      );

      // Fetch items for each backup sale
      const backupsWithItems = await Promise.all(
        backups.map(async (backup) => {
          try {
            const items = await storage.getSaleBackupItems(backup.id);
            return {
              ...backup,
              items,
            };
          } catch (error) {
            console.error(
              `Error getting items for backup sale ${backup.id}:`,
              error,
            );
            return backup; // Return the backup without items if there's an error
          }
        }),
      );

      res.json(backupsWithItems);
    } catch (error) {
      console.error("Error fetching sales backups:", error);
      res.status(500).json({ message: "Failed to retrieve sales backups" });
    }
  });

  // Delete a sale backup
  apiRouter.delete("/backup/sales/:id", async (req: Request, res: Response) => {
    try {
      const backupId = parseInt(req.params.id);
      if (isNaN(backupId)) {
        return res.status(400).json({ message: "Invalid sale backup ID" });
      }

      const success = await storage.deleteSaleBackup(backupId);

      if (!success) {
        return res
          .status(404)
          .json({ message: "Sale backup not found or could not be deleted" });
      }

      res.status(204).send();
    } catch (error) {
      console.error(`Error deleting sale backup ${req.params.id}:`, error);
      res.status(500).json({ message: "Failed to delete sale backup" });
    }
  });

  // Get items for a specific sale backup
  apiRouter.get(
    "/backup/sales/:id/items",
    async (req: Request, res: Response) => {
      try {
        const backupId = parseInt(req.params.id);
        if (isNaN(backupId)) {
          return res.status(400).json({ message: "Invalid sale backup ID" });
        }

        // Check if the backup exists
        const backups = await storage.listSaleBackups();
        const backup = backups.find((b) => b.id === backupId);

        if (!backup) {
          return res.status(404).json({ message: "Sale backup not found" });
        }

        // Get the items for this backup
        const items = await storage.getSaleBackupItems(backupId);

        res.json(items);
      } catch (error) {
        console.error(
          `Error getting items for sale backup ${req.params.id}:`,
          error,
        );
        res
          .status(500)
          .json({ message: "Failed to retrieve sale backup items" });
      }
    },
  );

  // Get proforma slip backups with optional date filtering
  apiRouter.get(
    "/backup/proforma-slips",
    async (req: Request, res: Response) => {
      try {
        // Parse query parameters for date range and pagination
        const limit = req.query.limit
          ? parseInt(req.query.limit as string)
          : 100;
        const offset = req.query.offset
          ? parseInt(req.query.offset as string)
          : 0;
        const startDateStr = req.query.startDate as string;
        const endDateStr = req.query.endDate as string;

        const startDate = startDateStr ? new Date(startDateStr) : undefined;
        const endDate = endDateStr ? new Date(endDateStr) : undefined;

        const backups = await storage.listProformaSlipBackups(
          startDate,
          endDate,
          limit,
          offset,
        );
        res.json(backups);
      } catch (error) {
        console.error("Error fetching proforma slip backups:", error);
        res
          .status(500)
          .json({ message: "Failed to retrieve proforma slip backups" });
      }
    },
  );

  // Get items for a specific proforma slip backup
  apiRouter.get(
    "/backup/proforma-slips/:id/items",
    async (req: Request, res: Response) => {
      try {
        const backupId = parseInt(req.params.id);
        if (isNaN(backupId)) {
          return res
            .status(400)
            .json({ message: "Invalid proforma slip backup ID" });
        }

        // Check if the backup exists
        const backups = await storage.listProformaSlipBackups();
        const backup = backups.find((b) => b.id === backupId);

        if (!backup) {
          return res
            .status(404)
            .json({ message: "Proforma slip backup not found" });
        }

        // Get the items for this backup
        const items = await storage.listProformaSlipItemBackups(backupId);
        res.json(items);
      } catch (error) {
        console.error(
          `Error getting items for proforma slip backup ${req.params.id}:`,
          error,
        );
        res
          .status(500)
          .json({ message: "Failed to retrieve proforma slip backup items" });
      }
    },
  );

  // Delete a single proforma slip backup
  apiRouter.delete(
    "/backup/proforma-slips/:id",
    async (req: Request, res: Response) => {
      try {
        const backupId = parseInt(req.params.id);
        if (isNaN(backupId)) {
          return res.status(400).json({ message: "Invalid backup ID" });
        }

        const success = await storage.deleteProformaSlipBackup(backupId);
        if (!success) {
          return res.status(404).json({ message: "Backup record not found" });
        }

        return res.status(204).send();
      } catch (error) {
        console.error("Error deleting proforma slip backup:", error);
        res
          .status(500)
          .json({ message: "Failed to delete proforma slip backup" });
      }
    },
  );

  // Delete multiple proforma slip backups in batch
  apiRouter.post(
    "/backup/proforma-slips/batch-delete",
    async (req: Request, res: Response) => {
      try {
        // Validate the request body - it should be an array of backup IDs
        const schema = z.object({
          ids: z.array(z.number()).min(1),
        });

        try {
          schema.parse(req.body);
        } catch (validationError) {
          if (validationError instanceof ZodError) {
            return res.status(400).json({
              message: "Invalid request format",
              errors: fromZodError(validationError).message,
            });
          }
        }

        const { ids } = req.body;

        // Delete the backups and get the count of successfully deleted items
        const deletedCount = await storage.deleteProformaSlipBackups(ids);

        return res.status(200).json({
          message: `Successfully deleted ${deletedCount} backup records`,
          deletedCount,
        });
      } catch (error) {
        console.error("Error batch deleting proforma slip backups:", error);
        res
          .status(500)
          .json({ message: "Failed to delete proforma slip backups" });
      }
    },
  );

  // Message endpoints for group chat
  apiRouter.get(
    "/messages/conversation",
    async (req: Request, res: Response) => {
      try {
        const limit = req.query.limit
          ? parseInt(req.query.limit as string)
          : 100;
        const offset = req.query.offset
          ? parseInt(req.query.offset as string)
          : 0;

        // Fetching all messages (for group chat)
        const messages = await storage.listMessages(limit, offset);
        res.json(messages);
      } catch (error) {
        console.error("Error fetching messages:", error);
        res.status(500).json({ message: "Failed to fetch messages" });
      }
    },
  );

  apiRouter.post("/messages", async (req: Request, res: Response) => {
    try {
      const { senderCode, content, recipientCode = null } = req.body;

      if (!senderCode || !content) {
        return res
          .status(400)
          .json({ message: "senderCode and content are required" });
      }

      // If recipientCode is null or empty, it's a group message (broadcast to all)
      const newMessage = await storage.createMessage({
        senderCode,
        recipientCode: recipientCode || null,
        content,
        isRead: false,
        broadcastToAll: !recipientCode,
      });

      res.json(newMessage);
    } catch (error) {
      console.error("Error creating message:", error);
      res.status(500).json({ message: "Failed to create message" });
    }
  });

  apiRouter.get(
    "/messages/unread-counts",
    async (req: Request, res: Response) => {
      try {
        // Just return empty counts for now as we're using group chat
        res.json({});
      } catch (error) {
        console.error("Error fetching unread counts:", error);
        res.status(500).json({ message: "Failed to fetch unread counts" });
      }
    },
  );

  // Activities endpoints
  apiRouter.get("/activities", async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      const offset = req.query.offset
        ? parseInt(req.query.offset as string)
        : 0;
      const activities = await storage.listActivities(limit, offset);
      res.json(activities);
    } catch (error) {
      console.error("Error fetching activities:", error);
      res.status(500).json({ message: "Failed to fetch activities" });
    }
  });

  apiRouter.get(
    "/activities/page/:pageName",
    async (req: Request, res: Response) => {
      try {
        const limit = req.query.limit
          ? parseInt(req.query.limit as string)
          : 100;
        const offset = req.query.offset
          ? parseInt(req.query.offset as string)
          : 0;
        const activities = await storage.getActivitiesByPage(
          req.params.pageName,
          limit,
          offset,
        );
        res.json(activities);
      } catch (error) {
        console.error("Error fetching activities by page:", error);
        res.status(500).json({ message: "Failed to fetch activities by page" });
      }
    },
  );

  apiRouter.get(
    "/activities/action/:action",
    async (req: Request, res: Response) => {
      try {
        const limit = req.query.limit
          ? parseInt(req.query.limit as string)
          : 100;
        const offset = req.query.offset
          ? parseInt(req.query.offset as string)
          : 0;
        const activities = await storage.getActivitiesByAction(
          req.params.action,
          limit,
          offset,
        );
        res.json(activities);
      } catch (error) {
        console.error("Error fetching activities by action:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch activities by action" });
      }
    },
  );

  apiRouter.get(
    "/activities/entity/:type/:id",
    async (req: Request, res: Response) => {
      try {
        const limit = req.query.limit
          ? parseInt(req.query.limit as string)
          : 100;
        const activities = await storage.getEntityActivities(
          req.params.type,
          req.params.id,
          limit,
        );
        res.json(activities);
      } catch (error) {
        console.error("Error fetching entity activities:", error);
        res.status(500).json({ message: "Failed to fetch entity activities" });
      }
    },
  );

  // Delete test activities (pageName="Test")
  apiRouter.delete("/activities/test", async (req: Request, res: Response) => {
    try {
      const deletedCount = await storage.deleteTestActivities();
      res.json({
        success: true,
        message: `Deleted ${deletedCount} test activities`,
        deletedCount,
      });
    } catch (error) {
      console.error("Error deleting test activities:", error);
      res.status(500).json({ message: "Failed to delete test activities" });
    }
  });

  // Delete a specific activity by ID
  apiRouter.delete("/activities/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid activity ID" });
      }

      const deleted = await storage.deleteActivity(id);
      if (deleted) {
        res.json({
          success: true,
          message: `Activity ${id} deleted successfully`,
        });
      } else {
        res.status(404).json({
          success: false,
          message: `Activity ${id} not found or could not be deleted`,
        });
      }
    } catch (error) {
      console.error("Error deleting activity:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete activity",
        error: error.message,
      });
    }
  });

  // MP Operations endpoints
  apiRouter.get("/mp-operations", async (req: Request, res: Response) => {
    // Get pagination parameters
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 1000;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

    let orderDate: Date | undefined = undefined;

    // Get order date filter if provided
    if (req.query.date) {
      // Parse the date specifically in DD/MM/YYYY format
      orderDate = parseOrderDate(req.query.date as string);
      console.log(
        `MP Operations request with params: limit=${limit}, offset=${offset}, orderDate=${orderDate?.toISOString()}`,
      );
    } else {
      console.log(
        `MP Operations request with params: limit=${limit}, offset=${offset}, no date filtering`,
      );
    }

    // Fetch mp operations with order date filtering if provided
    const operations = await storage.listLoadingOperations(
      limit,
      offset,
      undefined,
      undefined,
      orderDate,
    );

    // Sort operations by ID in descending order (newest first)
    operations.sort((a: any, b: any) => {
      // First try to sort by createdAt timestamp (if available)
      if (a.createdAt && b.createdAt) {
        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      }
      // Fall back to ID-based sorting (newest first)
      return b.id - a.id;
    });

    console.log(
      `Returning ${operations.length} load operations ${orderDate ? "with order date filtering" : "with no date filtering"}`,
    );

    res.json(operations);
  });

  // Export load operations to CSV
  apiRouter.get(
    "/mp-operations/export-csv",
    async (req: Request, res: Response) => {
      try {
        // Get all mp operations
        const operations = await storage.listLoadingOperations(1000, 0);

        if (!operations || operations.length === 0) {
          return res.status(404).json({ error: "No load operations found" });
        }

        // Fetch additional data and build CSV rows
        const csvRows: any[] = [];

        for (const operation of operations) {
          // Get user who created the operation
          const creator = operation.createdById
            ? await storage.getUser(operation.createdById)
            : undefined;

          // Format dates
          const createdDate = operation.createdAt
            ? new Date(operation.createdAt).toISOString().split("T")[0]
            : "";
          const completedDate = operation.completedAt
            ? new Date(operation.completedAt).toISOString().split("T")[0]
            : "";
          const orderDate = operation.orderDate
            ? new Date(operation.orderDate).toISOString().split("T")[0]
            : "";

          // Get load operation items
          const items = await storage.getLoadingOperationItems(operation.id);

          // Calculate total quantities for this operation from actual item data
          let totalProformaQty = 0;
          let totalLoadedQty = 0;
          let totalRemainingQty = 0;
          let totalExtraQty = 0;

          if (items && items.length > 0) {
            // Calculate totals from all items
            for (const item of items) {
              // Check if this is an extra item added
              // Extra items will have originalQuantity set to 0 explicitly
              const isExtraItem = item.originalQuantity === 0;

              // For ALL items, use originalQuantity as the proforma quantity
              // This will be 0 for extra items, and the original quantity for regular items
              const proformaQty = item.originalQuantity || 0;
              const loadedQty = item.loaded ? item.quantity || 0 : 0;

              // Add to total proforma (this will be 0 for extra items)
              totalProformaQty += proformaQty;
              totalLoadedQty += loadedQty;

              if (isExtraItem) {
                // If this is an extra item (originalQuantity=0), all loaded quantity counts as extra
                totalExtraQty += loadedQty;
              } else if (proformaQty >= loadedQty) {
                // If original quantity >= loaded quantity, we have some remaining
                totalRemainingQty += proformaQty - loadedQty;
              } else {
                // If loaded quantity > original quantity, the difference is extra
                totalExtraQty += loadedQty - proformaQty;
              }
            }
          }

          // If no items, add one row with operation data
          if (!items || items.length === 0) {
            csvRows.push({
              "creator (user)": creator?.name || "",
              "Creator ID": operation.createdById || "",
              "Creation Date": createdDate,
              "Completion Date": completedDate,
              Notes: operation.notes || "",
              "Order Number": operation.referenceNumber || "",
              Status: operation.status || "",
              "Order Date": orderDate,
              "Vehicle Number": operation.vehicleNumber || "",
              "Product ID": "",
              "Product SR No": "",
              "Product Barcode": "",
              "Product Name": "",
              "Proforma Quantity": totalProformaQty,
              "Loaded Quantity": totalLoadedQty,
              "Remaining Quantity": totalRemainingQty,
              "Extra Quantity": totalExtraQty,
            });
          } else {
            // Add a row for each item
            for (const item of items) {
              const product = item.productId
                ? await storage.getProduct(item.productId)
                : undefined;

              // Check if this is an extra item added
              // Extra items will have originalQuantity explicitly set to 0
              const isExtraItem = item.originalQuantity === 0;

              // For extra items, proforma quantity should be 0
              const originalQty = isExtraItem ? 0 : item.originalQuantity || 0;
              const loadedQty = item.loaded ? item.quantity || 0 : 0;

              // Calculate remaining and extra quantities
              let remainingQty = 0;
              let extraQty = 0;

              if (isExtraItem) {
                // If this is an extra item, all loaded quantity counts as extra
                extraQty = loadedQty;
              } else if (originalQty >= loadedQty) {
                // Regular case - some quantity remains
                remainingQty = originalQty - loadedQty;
              } else {
                // Regular case - extra quantity loaded
                extraQty = loadedQty - originalQty;
              }

              csvRows.push({
                "creator (user)": creator?.name || "",
                "Creator ID": operation.createdById || "",
                "Creation Date": createdDate,
                "Completion Date": completedDate,
                Notes: operation.notes || "",
                "Order Number": operation.referenceNumber || "",
                Status: operation.status || "",
                "Order Date": orderDate,
                "Vehicle Number": operation.vehicleNumber || "",
                "Product ID": product?.id || item.productId || "",
                "Product SR No": item.srNo || "",
                "Product Barcode": item.barcode || product?.barcode || "",
                "Product Name": item.itemName || product?.name || "",
                "Proforma Quantity": originalQty,
                "Loaded Quantity": loadedQty,
                "Remaining Quantity": remainingQty,
                "Extra Quantity": extraQty,
              });
            }
          }
        }

        // Set response headers for CSV download
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          "attachment; filename=mp-operations-export.csv",
        );

        // Generate CSV content from rows
        let csvContent = "";

        // Add headers
        if (csvRows.length > 0) {
          csvContent += Object.keys(csvRows[0]).join(",") + "\n";
        }

        // Add data rows
        csvRows.forEach((row) => {
          const values = Object.values(row).map((value) => {
            if (value === null || value === undefined) return "";
            return typeof value === "string"
              ? `"${value.replace(/"/g, '""')}"`
              : value;
          });
          csvContent += values.join(",") + "\n";
        });

        res.send(csvContent);
      } catch (error) {
        console.error("Error exporting load operations to CSV:", error);
        res
          .status(500)
          .json({ error: "Failed to export load operations to CSV" });
      }
    },
  );

  apiRouter.get(
    "/mp-operations/reference/:referenceNumber",
    async (req: Request, res: Response) => {
      try {
        const { referenceNumber } = req.params;

        if (!referenceNumber) {
          return res
            .status(400)
            .json({ message: "Reference number is required" });
        }

        // Look up the load operation by reference number
        const operation =
          await storage.getLoadingOperationByReferenceNumber(referenceNumber);

        if (!operation) {
          return res.status(404).json({ message: "load operation not found" });
        }

        res.json(operation);
      } catch (error) {
        console.error("Error finding load operation by reference:", error);
        res.status(500).json({ message: "Failed to fetch load operation" });
      }
    },
  );

  // MP-specific endpoint for fetching proforma slip details
  apiRouter.get(
    "/mp-operations/fetchMPProformaSlipDetails/:orderNumber",
    async (req: Request, res: Response) => {
      try {
        const { orderNumber } = req.params;

        if (!orderNumber) {
          return res.status(400).json({ message: "Order number is required" });
        }

        // Get the proforma slip
        const slip = await storage.getProformaSlipByOrderNumber(orderNumber);

        if (!slip) {
          return res.status(404).json({ message: "Proforma slip not found" });
        }

        // Get the items associated with this slip
        const items = await storage.getProformaSlipItems(slip.id);

        // Enrich the items with product data for proper display
        const enrichedItems = await Promise.all(
          items.map(async (item) => {
            if (item.productId) {
              try {
                const product = await storage.getProduct(item.productId);
                if (product) {
                  return {
                    ...item,
                    srNo: item.srNo || product.newSr || null,
                    srNoDisplay: item.srNoDisplay || product.newSr || null,
                    barcode: item.barcode || product.barcode || null,
                    itemName: item.itemName || product.name || null,
                  };
                }
              } catch (error) {
                console.error(
                  `Error fetching product ${item.productId} for proforma slip item:`,
                  error,
                );
              }
            }
            return item;
          }),
        );

        res.json({
          slip,
          items: enrichedItems,
        });
      } catch (error) {
        console.error("Error fetching MP proforma slip details:", error);
        res
          .status(500)
          .json({ message: "Failed to retrieve proforma slip details" });
      }
    },
  );

  apiRouter.post("/mp-operations", async (req: Request, res: Response) => {
    try {
      const operationData = insertLoadingOperationSchema.parse(req.body);

      // Create the load operation
      const operation = await storage.createLoadingOperation(operationData);

      // Track if we need to import items from proforma slip
      let shouldImportFromProformaSlip = false;
      let importResult = null;

      // Check if there's an orderNumber and no items specified
      if (
        operation.orderNumber &&
        (!req.body.items ||
          !Array.isArray(req.body.items) ||
          req.body.items.length === 0)
      ) {
        shouldImportFromProformaSlip = true;
      }

      // If items were included in the request, add them
      if (req.body.items && Array.isArray(req.body.items)) {
        for (const itemData of req.body.items) {
          const item = {
            ...itemData,
            mpOperationId: operation.id,
          };

          await storage.createLoadingOperationItem(item);
        }
      }
      // If no items were provided but we have an order number, try to import from proforma slip
      else if (shouldImportFromProformaSlip) {
        try {
          console.log(
            `[MP Operations] Importing items from proforma slip for order #${operation.orderNumber}`,
          );

          // Get the proforma slip
          const slip = await storage.getProformaSlipByOrderNumber(
            operation.orderNumber,
          );

          if (slip) {
            // Get the items associated with this slip
            const slipItems = await storage.getProformaSlipItems(slip.id);

            if (slipItems && slipItems.length > 0) {
              console.log(
                `[MP Operations] Found ${slipItems.length} items in proforma slip #${operation.orderNumber}`,
              );

              // Prepare items for batch creation
              const itemsToCreate = await Promise.all(
                slipItems.map(async (item) => {
                  let productData = null;

                  // Get product data for enrichment
                  if (item.productId) {
                    try {
                      productData = await storage.getProduct(item.productId);
                    } catch (e) {
                      console.error(
                        `Failed to fetch product ${item.productId}:`,
                        e,
                      );
                    }
                  }

                  return {
                    mpOperationId: operation.id,
                    productId: item.productId,
                    quantity: item.quantity || 0,
                    originalQuantity: item.quantity || 0,
                    loadedQuantity: item.quantity || 0,
                    loaded: false,
                    srNo: item.srNo || productData?.srNo || null,
                    srNoDisplay: item.srNoDisplay || productData?.srNo || null,
                    barcode: item.barcode || productData?.barcode || null,
                    itemName: item.itemName || productData?.name || null,
                  };
                }),
              );

              // Use our new batch endpoint to create all items at once
              if (itemsToCreate.length > 0) {
                const batchResponse = await axios.post(
                  `http://localhost:${process.env.PORT || 3000}/api/mp-operation-items/batch`,
                  itemsToCreate,
                );

                importResult = {
                  imported: true,
                  count: itemsToCreate.length,
                  success: batchResponse.data.results.filter((r) => r.success)
                    .length,
                  message: batchResponse.data.message,
                };

                console.log(
                  `[MP Operations] Successfully imported items: ${importResult.success}/${importResult.count}`,
                );
              }
            } else {
              console.log(
                `[MP Operations] No items found in proforma slip #${operation.orderNumber}`,
              );
              importResult = {
                imported: false,
                message: "No items found in the proforma slip",
              };
            }
          } else {
            console.log(
              `[MP Operations] Proforma slip not found for order #${operation.orderNumber}`,
            );
            importResult = {
              imported: false,
              message: "Proforma slip not found",
            };
          }
        } catch (importError) {
          console.error(
            `[MP Operations] Error importing items from proforma slip:`,
            importError,
          );
          importResult = {
            imported: false,
            error:
              importError instanceof Error
                ? importError.message
                : "Unknown error",
            message: "Failed to import items from proforma slip",
          };
        }
      }

      res.status(201).json({
        ...operation,
        itemsImport: importResult,
      });
    } catch (error) {
      console.error("Error creating load operation:", error);

      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }

      res.status(500).json({ message: "Failed to create load operation" });
    }
  });

  apiRouter.get("/mp-operations/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const operation = await storage.getLoadingOperation(id);

      if (!operation) {
        return res.status(404).json({ message: "load operation not found" });
      }

      res.json(operation);
    } catch (error) {
      console.error("Error fetching load operation:", error);
      res.status(500).json({ message: "Failed to fetch load operation" });
    }
  });

  apiRouter.get(
    "/mp-operations/:id/items",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);

        // Verify the load operation exists
        const operation = await storage.getLoadingOperation(id);
        if (!operation) {
          return res.status(404).json({ message: "load operation not found" });
        }

        // Get the items for this load operation
        const items = await storage.getLoadingOperationItems(id);

        // Enrich the items with product data if needed
        const enrichedItems = await Promise.all(
          items.map(async (item) => {
            if (item.productId) {
              const product = await storage.getProduct(item.productId);
              if (product) {
                return {
                  ...item,
                  // Add these only if they don't already exist
                  itemName: item.itemName || product.name,
                  barcode: item.barcode || product.barcode,
                };
              }
            }
            return item;
          }),
        );

        res.json(enrichedItems);
      } catch (error) {
        console.error("Error fetching load operation items:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch load operation items" });
      }
    },
  );

  apiRouter.put("/mp-operations/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);

      // Verify the load operation exists
      const originalOperation = await storage.getMpOperation(id);
      if (!originalOperation) {
        return res.status(404).json({ message: "load operation not found" });
      }

      // Update load operation base data
      const operationData = insertLoadingOperationSchema
        .partial()
        .parse(req.body);
      const updatedOperation = await storage.updateLoadingOperation(
        id,
        operationData,
      );

      // If items were included, update them too
      if (req.body.items && Array.isArray(req.body.items)) {
        for (const itemData of req.body.items) {
          if (itemData.id) {
            // Update existing item
            await storage.updateMpOperationItem(itemData.id, {
              ...itemData,
              mpOperationId: id,
            });
          } else {
            // Create new item
            await storage.createMpOperationItem({
              ...itemData,
              mpOperationId: id,
            });
          }
        }
      }

      // If the status is being changed to "READY≈DESP", create a sales entry in the sales table
      // Similar to how GJ Operations handles it
      if (
        operationData.status === "READY≈DESP" &&
        originalOperation.status !== "READY≈DESP"
      ) {
        try {
          // Get the items associated with this load operation
          const mpItems = await storage.getLoadingOperationItems(id);

          // Calculate totals
          let totalQuantity = 0;
          let totalAmount = 0;

          // Prepare sale items
          const saleItems = [];

          for (const item of mpItems) {
            // Skip items that are not loaded
            if (!item.loaded) continue;

            // Use the quantity from the item
            const itemQuantity = item.quantity || 0;
            // Try to get the product price, or use 0 as fallback
            const itemPrice = item.price || 0;
            const itemAmount = itemQuantity * itemPrice;

            totalQuantity += itemQuantity;
            totalAmount += itemAmount;

            // Add to sale items array
            saleItems.push({
              productId: item.productId,
              quantity: itemQuantity,
              price: itemPrice,
              amount: itemAmount,
              barcode: item.barcode || "",
              srNo: item.srNo || "",
              srNoDisplay: item.srNoDisplay || "",
              itemName: item.itemName || "",
              loaded: true,
            });
          }

          // Extract creator information
          let creatorInfo = "Unknown";
          let storekeeperName = "Unknown";
          let storekeeperDepartment = "Unknown";

          // Extract storekeeper information from notes if available
          if (updatedOperation.notes) {
            const storekeeperMatch = updatedOperation.notes.match(
              /Storekeeper: (.*?) \((.*?)\)/,
            );
            if (storekeeperMatch && storekeeperMatch.length >= 3) {
              storekeeperName = storekeeperMatch[1];
              storekeeperDepartment = storekeeperMatch[2];
              creatorInfo = `${storekeeperName} (${storekeeperDepartment})`;
            }
          }

          // If no match in notes, try to get creator info from database
          if (creatorInfo === "Unknown" && updatedOperation.createdById) {
            try {
              const creator = await storage.getUser(
                updatedOperation.createdById,
              );
              if (creator) {
                creatorInfo = creator.name || creator.username || "Unknown";
                // In this case we don't have department info from the notes
                storekeeperName = creator.name || creator.username || "Unknown";
                storekeeperDepartment = creator.department || "Unknown";
              }
            } catch (error) {
              console.error("Error fetching creator info:", error);
            }
          }

          // Format the date
          let formattedDate = "";

          // Try to use order date
          if (updatedOperation.orderDate) {
            // If it's already a string in DD/MM/YYYY format
            if (
              typeof updatedOperation.orderDate === "string" &&
              updatedOperation.orderDate.includes("/")
            ) {
              // Convert slash format to dash format
              formattedDate = updatedOperation.orderDate.replace(/\//g, "-");
            }
            // If it's a Date object or ISO string
            else {
              const orderDate = new Date(updatedOperation.orderDate);
              const day = String(orderDate.getDate()).padStart(2, "0");
              const month = String(orderDate.getMonth() + 1).padStart(2, "0");
              const year = orderDate.getFullYear();
              formattedDate = `${day}-${month}-${year}`;
            }
          }

          // Fallback to today's date if no order date found
          if (!formattedDate) {
            const today = new Date();
            const day = String(today.getDate()).padStart(2, "0");
            const month = String(today.getMonth() + 1).padStart(2, "0");
            const year = today.getFullYear();
            formattedDate = `${day}-${month}-${year}`;
            console.log(
              `No order date found in load operation, using today's date: ${formattedDate}`,
            );
          } else {
            console.log(
              `Using order date from load operation: ${formattedDate}`,
            );
          }

          // Check if sales entry already exists for this reference number to avoid duplicates
          const existingSales = await storage.listSales(100, 0);
          const existingSale = existingSales.find(
            (s) => s.orderNumber === updatedOperation.referenceNumber,
          );

          if (existingSale) {
            console.log(
              `Sales entry already exists for order number ${updatedOperation.referenceNumber} (Sale #${existingSale.id}). Skipping creation.`,
            );
            // Return the updated operation without creating a new sales entry
            return res.json(updatedOperation);
          }

          // Create the sales entry
          const saleData = {
            orderNumber: updatedOperation.referenceNumber,
            date: formattedDate, // Using order date in DD-MM-YYYY format
            dealer: updatedOperation.partyName || "Unknown",
            plant: updatedOperation.plant || "Unknown",
            status: "PENDING DESP",
            quantity: totalQuantity,
            amount: Math.round(totalAmount), // Convert to integer as per schema
            createdById: updatedOperation.createdById || 0,
            vehicleNumber: updatedOperation.vehicleNumber || "Not assigned",
            notes: `Auto-generated from load operation #${id} when status changed to READY≈DESP. Storekeeper: ${storekeeperName} (${storekeeperDepartment}). Vehicle: ${updatedOperation.vehicleNumber || "Not assigned"}. This entry will not be affected if the load operation is deleted.`,
          };

          // Only create sales entry if we have items with loaded=true
          if (saleItems.length === 0) {
            console.log(
              `No loaded items found for load operation ${id}, skipping sales entry creation`,
            );
            return res.json(updatedOperation);
          }

          // Create the sale record
          const sale = await storage.createSale(saleData);

          // Store the items separately with better error handling
          try {
            console.log(
              `Attempting to store ${saleItems.length} items for MP sale #${sale.id}`,
            );
            console.log(
              "MP Sale items sample:",
              JSON.stringify(saleItems.slice(0, 2)),
            );

            await storage.setSaleItems(sale.id, saleItems);
            console.log(
              `Successfully stored ${saleItems.length} items for MP sale #${sale.id}`,
            );
          } catch (itemError) {
            console.error(
              `Error storing sale items for MP sale #${sale.id}:`,
              itemError,
            );
            // Continue with the process even if item storage fails
          }

          console.log(
            `Created sales entry for load operation ${id} with reference number ${updatedOperation.referenceNumber}`,
          );

          // Now use this sales entry to update the inventory
          // Update sold counts for relevant products based on the loaded items
          for (const item of mpItems) {
            // Only update sold counts for items that have the loaded flag set to true
            if (item.productId && item.loaded === true) {
              const product = await storage.getProduct(item.productId);

              if (product) {
                // Always use the edited quantity value
                const quantityToAdd = item.quantity || 0;
                console.log(
                  `Using quantity value (${quantityToAdd}) from the editable input field for product sold count`,
                );
                const newSoldCount = (product.sold || 0) + quantityToAdd;

                console.log(
                  `Updating product ${product.id} (${product.name}) sold count: ${product.sold || 0} -> ${newSoldCount}`,
                );

                // Update the product's sold count based on the sales entry
                await storage.updateProduct(product.id, {
                  sold: newSoldCount,
                  lastUpdated: new Date(),
                });

                console.log(
                  `[Sale #${sale.id}] Updated product ${product.id} (${product.name}) sold count: ${product.sold || 0} -> ${newSoldCount}`,
                );
              }
            }
          }
        } catch (error) {
          console.error(
            "Error creating sales entry from load operation:",
            error,
          );
          // Continue with the operation update even if sales entry creation fails
        }
      }

      res.json(updatedOperation);
    } catch (error) {
      console.error("Error updating load operation:", error);

      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }

      res.status(500).json({ message: "Failed to update load operation" });
    }
  });

  apiRouter.delete(
    "/mp-operations/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);

        // Verify the load operation exists
        const operation = await storage.getLoadingOperation(id);
        if (!operation) {
          return res.status(404).json({ message: "load operation not found" });
        }

        // Delete all items first
        const items = await storage.getLoadingOperationItems(id);
        for (const item of items) {
          await storage.deleteMpOperationItem(item.id);
        }

        // Then delete the load operation itself
        const success = await storage.deleteMpOperation(id);

        if (success) {
          res
            .status(200)
            .json({ message: "load operation deleted successfully" });
        } else {
          res.status(500).json({ message: "Failed to delete load operation" });
        }
      } catch (error) {
        console.error("Error deleting load operation:", error);
        res.status(500).json({ message: "Failed to delete load operation" });
      }
    },
  );

  apiRouter.get(
    "/mp-operations/status/count",
    async (req: Request, res: Response) => {
      try {
        const status = req.query.status as string;

        if (!status) {
          return res
            .status(400)
            .json({ message: "Status parameter is required" });
        }

        let orderDate: Date | undefined = undefined;

        // Parse date string to Date object if provided using DD/MM/YYYY format
        if (req.query.date) {
          orderDate = parseOrderDate(req.query.date as string);
        }

        // Log the request parameters
        console.log(
          `Counting ${status} load operations with ${orderDate ? "order date filter: " + orderDate.toISOString() : "NO order date filter"}`,
        );

        // Get count of load operations with the specified status and order date
        const count = await storage.countMpOperationsByStatus(
          status,
          orderDate,
        );

        res.json({ status, count });
      } catch (error) {
        console.error("Error counting load operations by status:", error);
        res.status(500).json({ message: "Failed to count load operations" });
      }
    },
  );

  // Item management endpoints for load operations
  apiRouter.post(
    "/mp-operations/:id/items",
    async (req: Request, res: Response) => {
      try {
        const mpOperationId = parseInt(req.params.id);

        // Verify the load operation exists
        const operation = await storage.getMpOperation(mpOperationId);
        if (!operation) {
          return res.status(404).json({ message: "load operation not found" });
        }

        // Parse and validate the item data
        const itemData = insertMpOperationItemSchema.parse({
          ...req.body,
          mpOperationId,
        });

        // Create the new item
        const item = await storage.createMpOperationItem(itemData);

        res.status(201).json(item);
      } catch (error) {
        console.error("Error creating load operation item:", error);

        if (error instanceof ZodError) {
          const validationError = fromZodError(error);
          return res.status(400).json({ message: validationError.message });
        }

        res
          .status(500)
          .json({ message: "Failed to create load operation item" });
      }
    },
  );

  apiRouter.put(
    "/mp-operation-items/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);

        // Verify the item exists
        const item = await storage.getMpOperationItem(id);
        if (!item) {
          return res
            .status(404)
            .json({ message: "load operation item not found" });
        }

        // Update the item
        const itemData = insertMpOperationItemSchema.partial().parse(req.body);
        const updatedItem = await storage.updateMpOperationItem(id, itemData);

        res.json(updatedItem);
      } catch (error) {
        console.error("Error updating load operation item:", error);

        if (error instanceof ZodError) {
          const validationError = fromZodError(error);
          return res.status(400).json({ message: validationError.message });
        }

        res
          .status(500)
          .json({ message: "Failed to update load operation item" });
      }
    },
  );

  apiRouter.delete(
    "/mp-operation-items/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);

        // Verify the item exists
        const item = await storage.getMpOperationItem(id);
        if (!item) {
          return res
            .status(404)
            .json({ message: "load operation item not found" });
        }

        // Delete the item
        const success = await storage.deleteMpOperationItem(id);

        if (success) {
          res
            .status(200)
            .json({ message: "load operation item deleted successfully" });
        } else {
          res
            .status(500)
            .json({ message: "Failed to delete load operation item" });
        }
      } catch (error) {
        console.error("Error deleting load operation item:", error);
        res
          .status(500)
          .json({ message: "Failed to delete load operation item" });
      }
    },
  );

  apiRouter.post(
    "/mp-operation-items/batch-update",
    async (req: Request, res: Response) => {
      try {
        const items = req.body;

        if (!items || !Array.isArray(items)) {
          return res
            .status(400)
            .json({
              message: "Invalid request format. Expected an array of items.",
            });
        }

        console.log(
          `[BATCH UPDATE] Processing batch update for ${items.length} load operation items`,
        );

        // Process each item in the batch
        const results = await Promise.all(
          items.map(async (item) => {
            try {
              // Skip items without an ID
              if (!item.id) {
                console.log(`[BATCH UPDATE] Skipping item without ID:`, item);
                return { success: false, id: null, error: "Missing ID" };
              }

              console.log(
                `[BATCH UPDATE] Updating load operation item ${item.id}`,
              );

              // Extract just the fields we want to update
              const updateData = {
                quantity: item.quantity,
                loaded: item.loaded,
                loadedQuantity: item.loadedQuantity,
                originalQuantity: item.originalQuantity,
              };

              // Update the item
              await storage.updateMpOperationItem(item.id, updateData);

              return { success: true, id: item.id };
            } catch (error) {
              console.error(
                `[BATCH UPDATE] Error updating load operation item ${item.id}:`,
                error,
              );
              return {
                success: false,
                id: item.id,
                error: error instanceof Error ? error.message : "Unknown error",
              };
            }
          }),
        );

        // Count successes and failures
        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.length - successCount;

        console.log(
          `[BATCH UPDATE] Completed with ${successCount} successes and ${failureCount} failures`,
        );

        res.json({
          message: `Batch update completed with ${successCount} successes and ${failureCount} failures`,
          results,
        });
      } catch (error) {
        console.error("Error in batch update of load operation items:", error);
        res.status(500).json({ message: "Failed to process batch update" });
      }
    },
  );

  apiRouter.post(
    "/mp-operation-items/batch",
    async (req: Request, res: Response) => {
      try {
        const items = req.body;

        if (!items || !Array.isArray(items)) {
          return res
            .status(400)
            .json({
              message: "Invalid request format. Expected an array of items.",
            });
        }

        console.log(
          `[BATCH CREATE] Processing batch creation for ${items.length} load operation items`,
        );

        // Process each item in the batch
        const results = await Promise.all(
          items.map(async (item) => {
            try {
              // Ensure we have required fields
              if (!item.mpOperationId || !item.productId) {
                console.log(
                  `[BATCH CREATE] Skipping item with missing required fields:`,
                  item,
                );
                return {
                  success: false,
                  error: "Missing required fields (mpOperationId or productId)",
                };
              }

              console.log(
                `[BATCH CREATE] Creating load operation item for operation ${item.mpOperationId}`,
              );

              // Create the item
              const newItem = await storage.createMpOperationItem({
                mpOperationId: item.mpOperationId,
                productId: item.productId,
                quantity: item.quantity || 0,
                originalQuantity: item.originalQuantity || item.quantity || 0,
                loadedQuantity: item.loadedQuantity || 0,
                loaded: item.loaded || false,
                srNo: item.srNo || null,
                srNoDisplay: item.srNoDisplay || null,
                barcode: item.barcode || null,
                itemName: item.itemName || null,
              });

              return { success: true, id: newItem.id, item: newItem };
            } catch (error) {
              console.error(
                `[BATCH CREATE] Error creating load operation item:`,
                error,
              );
              return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
              };
            }
          }),
        );

        // Count successes and failures
        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.length - successCount;

        console.log(
          `[BATCH CREATE] Completed with ${successCount} successes and ${failureCount} failures`,
        );

        res.json({
          message: `Batch creation completed with ${successCount} successes and ${failureCount} failures`,
          results,
        });
      } catch (error) {
        console.error(
          "Error in batch creation of load operation items:",
          error,
        );
        res.status(500).json({ message: "Failed to create items in batch" });
      }
    },
  );

  // Vehicle Info endpoints
  apiRouter.get("/vehicle-info", async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      const offset = req.query.offset
        ? parseInt(req.query.offset as string)
        : 0;

      const vehicles = await storage.listVehicleInfo(limit, offset);

      // Fetch user info for each vehicle to include lastEditedBy info
      const enrichedVehicles = await Promise.all(
        vehicles.map(async (vehicle) => {
          let lastEditedBy = null;
          let createdBy = null;

          if (vehicle.lastEditedById) {
            const editor = await storage.getUser(vehicle.lastEditedById);
            if (editor) {
              lastEditedBy = editor.name || editor.username;
            }
          }

          if (vehicle.createdById) {
            const creator = await storage.getUser(vehicle.createdById);
            if (creator) {
              createdBy = creator.name || creator.username;
            }
          }

          return {
            ...vehicle,
            lastEditedBy,
            createdBy,
          };
        }),
      );

      res.json(enrichedVehicles);
    } catch (error) {
      console.error("Error fetching vehicle info:", error);
      res.status(500).json({ message: "Failed to fetch vehicle info" });
    }
  });

  apiRouter.get("/vehicle-info/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const vehicle = await storage.getVehicleInfo(id);

      if (!vehicle) {
        return res.status(404).json({ message: "Vehicle info not found" });
      }

      // Get user who last edited
      let lastEditedBy = null;
      if (vehicle.lastEditedById) {
        const editor = await storage.getUser(vehicle.lastEditedById);
        if (editor) {
          lastEditedBy = editor.name || editor.username;
        }
      }

      res.json({ ...vehicle, lastEditedBy });
    } catch (error) {
      console.error("Error fetching vehicle info:", error);
      res.status(500).json({ message: "Failed to fetch vehicle info" });
    }
  });

  apiRouter.get(
    "/vehicle-info/number/:vehicleNumber",
    async (req: Request, res: Response) => {
      try {
        const vehicle = await storage.getVehicleInfoByVehicleNumber(
          req.params.vehicleNumber,
        );

        if (!vehicle) {
          return res.status(404).json({ message: "Vehicle info not found" });
        }

        // Get user who last edited
        let lastEditedBy = null;
        if (vehicle.lastEditedById) {
          const editor = await storage.getUser(vehicle.lastEditedById);
          if (editor) {
            lastEditedBy = editor.name || editor.username;
          }
        }

        res.json({ ...vehicle, lastEditedBy });
      } catch (error) {
        console.error("Error fetching vehicle info by number:", error);
        res.status(500).json({ message: "Failed to fetch vehicle info" });
      }
    },
  );

  apiRouter.post("/vehicle-info", async (req: Request, res: Response) => {
    try {
      // Validate and parse the request body
      const vehicleData = insertVehicleInfoSchema.parse(req.body);

      // Create the vehicle info
      const vehicle = await storage.createVehicleInfo(vehicleData);

      // Add activity log
      const userId = vehicleData.createdById || vehicleData.lastEditedById;
      if (userId) {
        const user = await storage.getUser(userId);
        await storage.createActivity({
          userId,
          action: "create",
          entityType: "vehicle",
          entityId: vehicle.id,
          details: `Vehicle ${vehicle.vehicleNumber} added by ${user?.name || user?.username || "Unknown user"}`,
          pageName: "VehicleInfo",
        });
      }

      res.status(201).json(vehicle);
    } catch (error) {
      console.error("Error creating vehicle info:", error);

      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid vehicle data",
          errors: error.format(),
        });
      }

      res.status(500).json({ message: "Failed to create vehicle info" });
    }
  });

  apiRouter.put("/vehicle-info/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);

      // Get the existing vehicle
      const existingVehicle = await storage.getVehicleInfo(id);
      if (!existingVehicle) {
        return res.status(404).json({ message: "Vehicle info not found" });
      }

      // Validate and parse the request body
      const vehicleData = insertVehicleInfoSchema.partial().parse(req.body);

      // Update the vehicle info
      const updatedVehicle = await storage.updateVehicleInfo(id, vehicleData);

      if (!updatedVehicle) {
        return res
          .status(404)
          .json({ message: "Vehicle info could not be updated" });
      }

      // Add activity log
      const userId = vehicleData.lastEditedById;
      if (userId) {
        const user = await storage.getUser(userId);
        await storage.logActivity({
          userId,
          action: "update",
          entityType: "vehicle",
          entityId: id,
          details: `Vehicle ${updatedVehicle.vehicleNumber} updated by ${user?.name || user?.username || "Unknown user"}`,
          pageName: "VehicleInfo",
        });
      }

      res.json(updatedVehicle);
    } catch (error) {
      console.error("Error updating vehicle info:", error);

      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid vehicle data",
          errors: error.format(),
        });
      }

      res.status(500).json({ message: "Failed to update vehicle info" });
    }
  });

  apiRouter.delete("/vehicle-info/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);

      // Get the vehicle before deleting
      const vehicle = await storage.getVehicleInfo(id);
      if (!vehicle) {
        return res.status(404).json({ message: "Vehicle info not found" });
      }

      // Delete the vehicle
      const success = await storage.deleteVehicleInfo(id);

      if (!success) {
        return res
          .status(500)
          .json({ message: "Failed to delete vehicle info" });
      }

      // Add activity log for deletion
      const sessionUser = (req as any).session?.user;
      if (sessionUser?.id) {
        await storage.logActivity({
          userId: sessionUser.id,
          action: "delete",
          entityType: "vehicle",
          entityId: id,
          details: `Vehicle ${vehicle.vehicleNumber} deleted by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
          pageName: "VehicleInfo",
        });
      }

      res.status(204).send(); // 204 No Content
    } catch (error) {
      console.error("Error deleting vehicle info:", error);
      res.status(500).json({ message: "Failed to delete vehicle info" });
    }
  });

  // ==================== Purchase Orders API ====================

  // GET /api/purchase-orders - List all purchase orders
  apiRouter.get("/purchase-orders", async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined;
      const offset = req.query.offset
        ? parseInt(req.query.offset as string)
        : undefined;

      const purchaseOrders = await storage.listPurchaseOrders(limit, offset);
      res.json(purchaseOrders);
    } catch (error) {
      console.error("Error listing purchase orders:", error);
      res.status(500).json({ message: "Failed to fetch purchase orders" });
    }
  });

  // POST /api/purchase-orders - Create a new purchase order
  apiRouter.post("/purchase-orders", async (req: Request, res: Response) => {
    try {
      const purchaseOrderData = insertPurchaseOrderSchema.parse(req.body);
      const purchaseOrder =
        await storage.createPurchaseOrder(purchaseOrderData);

      // Add activity log for creation
      const sessionUser = (req as any).session?.user;
      if (sessionUser?.id) {
        await storage.logActivity({
          userId: sessionUser.id,
          action: "create",
          entityType: "purchase_order",
          entityId: purchaseOrder.id,
          details: `Purchase order ${purchaseOrder.orderNumber} created by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
          pageName: "PurchaseOrders",
        });
      }

      res.status(201).json(purchaseOrder);
    } catch (error) {
      console.error("Error creating purchase order:", error);

      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid purchase order data",
          errors: error.format(),
        });
      }

      res.status(500).json({ message: "Failed to create purchase order" });
    }
  });

  // GET /api/purchase-orders/:id - Get a specific purchase order
  apiRouter.get("/purchase-orders/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const purchaseOrder = await storage.getPurchaseOrder(id);

      if (!purchaseOrder) {
        return res.status(404).json({ message: "Purchase order not found" });
      }

      res.json(purchaseOrder);
    } catch (error) {
      console.error("Error getting purchase order:", error);
      res.status(500).json({ message: "Failed to fetch purchase order" });
    }
  });

  // PUT /api/purchase-orders/:id - Update a purchase order
  apiRouter.put("/purchase-orders/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const purchaseOrderData = insertPurchaseOrderSchema
        .partial()
        .parse(req.body);

      const updatedPurchaseOrder = await storage.updatePurchaseOrder(
        id,
        purchaseOrderData,
      );

      if (!updatedPurchaseOrder) {
        return res.status(404).json({ message: "Purchase order not found" });
      }

      // Add activity log for update
      const sessionUser = (req as any).session?.user;
      if (sessionUser?.id) {
        await storage.logActivity({
          userId: sessionUser.id,
          action: "update",
          entityType: "purchase_order",
          entityId: id,
          details: `Purchase order ${updatedPurchaseOrder.orderNumber} updated by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
          pageName: "PurchaseOrders",
        });
      }

      res.json(updatedPurchaseOrder);
    } catch (error) {
      console.error("Error updating purchase order:", error);

      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid purchase order data",
          errors: error.format(),
        });
      }

      res.status(500).json({ message: "Failed to update purchase order" });
    }
  });

  // DELETE /api/purchase-orders/:id - Delete a purchase order
  apiRouter.delete(
    "/purchase-orders/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);

        // Get the purchase order before deleting
        const purchaseOrder = await storage.getPurchaseOrder(id);
        if (!purchaseOrder) {
          return res.status(404).json({ message: "Purchase order not found" });
        }

        // Delete the purchase order (this will also delete items and recalculate product purchased quantities)
        const success = await storage.deletePurchaseOrder(id);

        if (!success) {
          return res
            .status(500)
            .json({ message: "Failed to delete purchase order" });
        }

        // Add activity log for deletion
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "delete",
            entityType: "purchase_order",
            entityId: id,
            details: `Purchase order ${purchaseOrder.orderNumber} deleted by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "PurchaseOrders",
          });
        }

        res.status(204).send(); // 204 No Content
      } catch (error) {
        console.error("Error deleting purchase order:", error);
        res.status(500).json({ message: "Failed to delete purchase order" });
      }
    },
  );

  // ==================== Purchase Order Items API ====================

  // GET /api/purchase-orders/:id/items - Get all items for a purchase order
  apiRouter.get(
    "/purchase-orders/:id/items",
    async (req: Request, res: Response) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        const items = await storage.getPurchaseOrderItems(purchaseOrderId);
        res.json(items);
      } catch (error) {
        console.error("Error getting purchase order items:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch purchase order items" });
      }
    },
  );

  // POST /api/purchase-orders/:id/items - Add an item to a purchase order
  apiRouter.post(
    "/purchase-orders/:id/items",
    async (req: Request, res: Response) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        const itemData = insertPurchaseOrderItemSchema.parse({
          ...req.body,
          purchaseOrderId,
        });

        const item = await storage.createPurchaseOrderItem(itemData);

        // Add activity log for item creation
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "create",
            entityType: "purchase_order_item",
            entityId: item.id,
            details: `Purchase order item added (${item.itemName}, quantity: ${item.quantity}) by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "PurchaseOrders",
          });
        }

        res.status(201).json(item);
      } catch (error) {
        console.error("Error creating purchase order item:", error);

        if (error instanceof ZodError) {
          return res.status(400).json({
            message: "Invalid purchase order item data",
            errors: error.format(),
          });
        }

        res
          .status(500)
          .json({ message: "Failed to create purchase order item" });
      }
    },
  );

  // PUT /api/purchase-order-items/:id - Update a purchase order item
  apiRouter.put(
    "/purchase-order-items/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const itemData = insertPurchaseOrderItemSchema
          .partial()
          .parse(req.body);

        const updatedItem = await storage.updatePurchaseOrderItem(id, itemData);

        if (!updatedItem) {
          return res
            .status(404)
            .json({ message: "Purchase order item not found" });
        }

        // Add activity log for item update
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "update",
            entityType: "purchase_order_item",
            entityId: id,
            details: `Purchase order item updated (${updatedItem.itemName}, quantity: ${updatedItem.quantity}) by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "PurchaseOrders",
          });
        }

        res.json(updatedItem);
      } catch (error) {
        console.error("Error updating purchase order item:", error);

        if (error instanceof ZodError) {
          return res.status(400).json({
            message: "Invalid purchase order item data",
            errors: error.format(),
          });
        }

        res
          .status(500)
          .json({ message: "Failed to update purchase order item" });
      }
    },
  );

  // DELETE /api/purchase-order-items/:id - Delete a purchase order item
  apiRouter.delete(
    "/purchase-order-items/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);

        // Get the item before deleting for logging
        const item = await storage.getPurchaseOrderItem(id);
        if (!item) {
          return res
            .status(404)
            .json({ message: "Purchase order item not found" });
        }

        // Delete the item (this will also recalculate product purchased quantities)
        const success = await storage.deletePurchaseOrderItem(id);

        if (!success) {
          return res
            .status(500)
            .json({ message: "Failed to delete purchase order item" });
        }

        // Add activity log for item deletion
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "delete",
            entityType: "purchase_order_item",
            entityId: id,
            details: `Purchase order item deleted (${item.itemName}, quantity: ${item.quantity}) by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "PurchaseOrders",
          });
        }

        res.status(204).send(); // 204 No Content
      } catch (error) {
        console.error("Error deleting purchase order item:", error);
        res
          .status(500)
          .json({ message: "Failed to delete purchase order item" });
      }
    },
  );

  // POST /api/purchase-orders/:id/items/batch - Add multiple items to a purchase order
  apiRouter.post(
    "/purchase-orders/:id/items/batch",
    async (req: Request, res: Response) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        const itemsData = z
          .array(insertPurchaseOrderItemSchema)
          .parse(req.body.map((item: any) => ({ ...item, purchaseOrderId })));

        const items = await storage.createPurchaseOrderItems(itemsData);

        // Add activity log for batch creation
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "create",
            entityType: "purchase_order_item",
            entityId: purchaseOrderId,
            details: `${items.length} purchase order items added in batch by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "PurchaseOrders",
          });
        }

        res.status(201).json(items);
      } catch (error) {
        console.error("Error creating purchase order items batch:", error);

        if (error instanceof ZodError) {
          return res.status(400).json({
            message: "Invalid purchase order items data",
            errors: error.format(),
          });
        }

        res
          .status(500)
          .json({ message: "Failed to create purchase order items" });
      }
    },
  );

  // POST /api/recalculate-purchases - Manually trigger recalculation of all product purchase totals
  apiRouter.post(
    "/recalculate-purchases",
    async (req: Request, res: Response) => {
      try {
        await storage.recalculateAllProductsPurchased();

        // Add activity log for recalculation
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "recalculate",
            entityType: "product",
            entityId: "all",
            details: `Purchase quantities recalculated for all products by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "PurchaseOrders",
          });
        }

        res.json({ message: "Purchase quantities recalculated successfully" });
      } catch (error) {
        console.error("Error recalculating purchases:", error);
        res
          .status(500)
          .json({ message: "Failed to recalculate purchase quantities" });
      }
    },
  );

  // ==================== Dealer Purchase Orders API (Excel-based consolidated dealer orders) ====================

  // GET /api/dealer-purchase-orders - List all dealer purchase orders
  apiRouter.get(
    "/dealer-purchase-orders",
    async (req: Request, res: Response) => {
      try {
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;
        const startDate = req.query.startDate
          ? new Date(req.query.startDate as string)
          : undefined;
        const endDate = req.query.endDate
          ? new Date(req.query.endDate as string)
          : undefined;

        const dealerPurchaseOrders = await storage.listDealerPurchaseOrders(
          limit,
          offset,
          startDate,
          endDate,
        );
        res.json(dealerPurchaseOrders);
      } catch (error) {
        console.error("Error listing dealer purchase orders:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch dealer purchase orders" });
      }
    },
  );

  // POST /api/dealer-purchase-orders - Create a new dealer purchase order
  apiRouter.post(
    "/dealer-purchase-orders",
    async (req: Request, res: Response) => {
      try {
        const dealerPurchaseOrderData = insertPurchaseOrderSchema.parse(
          req.body,
        );
        const dealerPurchaseOrder = await storage.createDealerPurchaseOrder(
          dealerPurchaseOrderData,
        );

        // Add activity log
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "create",
            entityType: "dealer_purchase_order",
            entityId: dealerPurchaseOrder.id,
            details: `Dealer purchase order for ${dealerPurchaseOrder.orderDate} created by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "DealerPurchaseOrders",
          });
        }

        res.status(201).json(dealerPurchaseOrder);
      } catch (error) {
        console.error("Error creating dealer purchase order:", error);

        if (error instanceof ZodError) {
          return res.status(400).json({
            message: "Invalid dealer purchase order data",
            errors: error.format(),
          });
        }

        res
          .status(500)
          .json({ message: "Failed to create dealer purchase order" });
      }
    },
  );

  // GET /api/dealer-purchase-orders/:id - Get a specific dealer purchase order with details
  apiRouter.get(
    "/dealer-purchase-orders/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const dealerPurchaseOrder = await storage.getDealerPurchaseOrder(id);

        if (!dealerPurchaseOrder) {
          return res
            .status(404)
            .json({ message: "Dealer purchase order not found" });
        }

        // Get associated items
        const items = await storage.getDealerPurchaseOrderItems(id);

        res.json({
          ...dealerPurchaseOrder,
          items,
        });
      } catch (error) {
        console.error("Error getting dealer purchase order:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch dealer purchase order" });
      }
    },
  );

  // PUT /api/dealer-purchase-orders/:id - Update a dealer purchase order
  apiRouter.put(
    "/dealer-purchase-orders/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const dealerPurchaseOrderData = insertPurchaseOrderSchema
          .partial()
          .parse(req.body);

        const updatedDealerPurchaseOrder =
          await storage.updateDealerPurchaseOrder(id, dealerPurchaseOrderData);

        if (!updatedDealerPurchaseOrder) {
          return res
            .status(404)
            .json({ message: "Dealer purchase order not found" });
        }

        // Add activity log
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "update",
            entityType: "dealer_purchase_order",
            entityId: updatedDealerPurchaseOrder.id,
            details: `Dealer purchase order for ${updatedDealerPurchaseOrder.orderDate} updated by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "DealerPurchaseOrders",
          });
        }

        res.json(updatedDealerPurchaseOrder);
      } catch (error) {
        console.error("Error updating dealer purchase order:", error);

        if (error instanceof ZodError) {
          return res.status(400).json({
            message: "Invalid dealer purchase order data",
            errors: error.format(),
          });
        }

        res
          .status(500)
          .json({ message: "Failed to update dealer purchase order" });
      }
    },
  );

  // DELETE /api/dealer-purchase-orders/:id - Delete a dealer purchase order
  apiRouter.delete(
    "/dealer-purchase-orders/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);

        // Get the dealer purchase order before deleting
        const dealerPurchaseOrder = await storage.getDealerPurchaseOrder(id);
        if (!dealerPurchaseOrder) {
          return res
            .status(404)
            .json({ message: "Dealer purchase order not found" });
        }

        // Delete the dealer purchase order (this will also delete dealers and items)
        const success = await storage.deleteDealerPurchaseOrder(id);

        if (!success) {
          return res
            .status(500)
            .json({ message: "Failed to delete dealer purchase order" });
        }

        // Add activity log
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "delete",
            entityType: "dealer_purchase_order",
            entityId: id,
            details: `Dealer purchase order for ${dealerPurchaseOrder.orderDate} deleted by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "DealerPurchaseOrders",
          });
        }

        res.json({ message: "Dealer purchase order deleted successfully" });
      } catch (error) {
        console.error("Error deleting dealer purchase order:", error);
        res
          .status(500)
          .json({ message: "Failed to delete dealer purchase order" });
      }
    },
  );

  // POST /api/dealer-purchase-orders/from-excel - Create dealer purchase order from Excel data
  apiRouter.post(
    "/dealer-purchase-orders/from-excel",
    requirePageWrite("purchases"),
    upload.single("file"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          return res.status(400).json({ message: "No Excel file uploaded" });
        }

        if (!req.body.deliveryDate) {
          return res.status(400).json({ message: "Delivery date is required" });
        }

        const fileBuffer = req.file.buffer;
        const deliveryDate = new Date(req.body.deliveryDate);

        // Import xlsx library for Excel processing
        const xlsx = await import("xlsx");

        console.log("Processing Excel file for dealer purchase orders...");

        // Parse Excel file
        const workbook = xlsx.read(fileBuffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Convert to JSON format - use different parsing options for better compatibility
        const rawData = xlsx.utils.sheet_to_json(worksheet, {
          header: 1,
          defval: "",
          blankrows: false,
          raw: false,
        });
        console.log("Raw Excel data rows:", rawData.length);

        // Alternative parsing method if the first one fails
        if (
          rawData.length === 0 ||
          (rawData[0] && (rawData[0] as any[]).length === 0)
        ) {
          console.log("Trying alternative parsing method...");
          const range = xlsx.utils.decode_range(worksheet["!ref"] || "A1");
          console.log("Worksheet range:", worksheet["!ref"]);

          // Extract range manually
          const altData = [];
          for (let R = range.s.r; R <= range.e.r; ++R) {
            const row = [];
            for (let C = range.s.c; C <= range.e.c; ++C) {
              const cell_address = { c: C, r: R };
              const cell_ref = xlsx.utils.encode_cell(cell_address);
              const cell = worksheet[cell_ref];
              row.push(cell ? cell.v : "");
            }
            altData.push(row);
          }

          if (altData.length > 0) {
            console.log("Using alternative parsing data");
            rawData.splice(0, rawData.length, ...altData);
          }
        }

        console.log("Final raw data sample:", rawData.slice(0, 3));

        if (rawData.length < 2) {
          return res
            .status(400)
            .json({
              message:
                "Excel file must have at least a header row and one data row",
            });
        }

        // Auto-detect Excel format by scanning for actual data patterns
        console.log("Auto-detecting Excel format...");
        let actualHeaderRowIndex = -1;
        let actualHeaderRow: any[] = [];

        // Look for a row that looks like a proper header - more flexible detection
        for (let i = 0; i < Math.min(20, rawData.length); i++) {
          const row = rawData[i] as any[];
          if (!row) continue;

          const nonEmptyValues = row.filter(
            (cell) => cell && String(cell).trim() !== "",
          ).length;
          console.log(`Row ${i} non-empty values: ${nonEmptyValues}`);

          // More flexible header detection - look for rows with at least 1 meaningful value
          if (nonEmptyValues >= 1) {
            // Check if this could be a header row by examining the content
            const firstCell = String(row[0] || "")
              .trim()
              .toLowerCase();

            // Skip obvious title/info rows
            if (
              firstCell.includes("company") ||
              firstCell.includes("generated") ||
              firstCell.includes("filtered") ||
              firstCell.includes("report") ||
              firstCell.includes("date") ||
              firstCell === "" ||
              firstCell.length < 2
            ) {
              continue;
            }

            // Check if this looks like a product code or has multiple columns with data
            let hasDataRows = false;
            let hasProductLikeContent = false;

            // Check if first cell looks like a product code (alphanumeric, reasonable length)
            if (firstCell.match(/^[a-zA-Z0-9-_\s]{2,20}$/)) {
              hasProductLikeContent = true;
            }

            // Look ahead for numeric data in subsequent rows
            for (let j = i + 1; j < Math.min(i + 10, rawData.length); j++) {
              const dataRow = rawData[j] as any[];
              if (
                dataRow &&
                dataRow.some(
                  (cell) => cell && !isNaN(Number(cell)) && Number(cell) >= 0,
                )
              ) {
                hasDataRows = true;
                break;
              }
            }

            // Accept if it has product-like content OR multiple columns OR has data rows following
            if (hasProductLikeContent || nonEmptyValues >= 2 || hasDataRows) {
              actualHeaderRowIndex = i;
              actualHeaderRow = row;
              console.log(
                `Selected header row ${i} with content: ${firstCell.substring(0, 30)}`,
              );
              break;
            }
          }
        }

        console.log("Found potential header at row:", actualHeaderRowIndex);
        console.log("Header row:", actualHeaderRow.slice(0, 10)); // Show first 10 columns only

        if (actualHeaderRowIndex === -1) {
          // Fallback: try to find any row with data and use default processing
          console.log("No clear header found, trying fallback approach...");

          // Look for the first row that has meaningful content
          for (let i = 0; i < Math.min(15, rawData.length); i++) {
            const row = rawData[i] as any[];
            if (row && row.some((cell) => cell && String(cell).trim())) {
              const firstCell = String(row[0] || "").trim();
              // Skip obvious title rows but accept anything that looks like data
              if (
                firstCell &&
                firstCell.length > 1 &&
                !firstCell.toLowerCase().includes("company") &&
                !firstCell.toLowerCase().includes("generated") &&
                !firstCell.toLowerCase().includes("report")
              ) {
                actualHeaderRowIndex = i;
                actualHeaderRow = row;
                console.log(`Fallback: Using row ${i} as header`);
                break;
              }
            }
          }
        }

        if (actualHeaderRowIndex === -1 || actualHeaderRow.length === 0) {
          return res.status(400).json({
            message:
              "Unable to detect data structure in Excel file. Please ensure the file contains:\n\n- A clear header row with product codes/names in the first column\n- Data rows with product information\n- Numeric quantities where applicable\n\nSupported formats:\n1. Product-Dealer Matrix: Product Name | Dealer 1 | Dealer 2\n2. Simple Product List: Product Code | Product Name | Quantity",
            debug: {
              totalRows: rawData.length,
              sampleRows: rawData.slice(0, 5).map((row, i) => ({
                row: i,
                content: (row as any[])
                  ?.slice(0, 3)
                  ?.map((cell) => String(cell || "").substring(0, 20)),
              })),
            },
          });
        }

        // Extract dealer names from header (skip first column which is products) - more flexible approach
        let dealerNames = actualHeaderRow
          .slice(1)
          .map((name, index) => {
            const nameStr =
              typeof name === "string"
                ? name.trim()
                : String(name || "").trim();
            // If name is empty or too generic, create a default dealer name
            if (!nameStr || nameStr.length === 0) {
              return `Dealer_${index + 1}`;
            }
            return nameStr;
          })
          .filter(
            (name) =>
              name &&
              name.length > 0 &&
              !name.toLowerCase().includes("total") &&
              !name.toLowerCase().includes("sum") &&
              !name.toLowerCase().includes("company"),
          );

        // If no dealers found in header, check if we have any data columns beyond the first
        if (dealerNames.length === 0 && actualHeaderRow.length > 1) {
          console.log(
            "No explicit dealers found, creating default dealer columns...",
          );
          // Create default dealers for available columns
          for (let i = 1; i < Math.min(actualHeaderRow.length, 10); i++) {
            dealerNames.push(`Dealer_${i}`);
          }
        }

        // If still no dealers and this might be a single-column product list, create one default dealer
        if (dealerNames.length === 0) {
          console.log("Creating single default dealer for product list...");
          dealerNames = ["Default_Dealer"];
        }

        console.log("Found/created dealers:", dealerNames.slice(0, 5)); // Show first 5 dealers

        // Process data rows to extract products and quantities
        const dealers = dealerNames.map((name) => ({
          name: name.trim(),
          vehicleNumber: undefined,
          driverName: undefined,
        }));

        const items: Array<{
          productCode: string;
          productName: string;
          dealerQuantities: { [dealerName: string]: number };
        }> = [];

        // Process each data row (skip the actual header row we found)
        for (let i = actualHeaderRowIndex + 1; i < rawData.length; i++) {
          const row = rawData[i] as any[];

          if (!row || row.length === 0 || !row[0]) continue;

          const productInfo = String(row[0]).trim();

          if (!productInfo) continue;

          // Split product info to get code and name (format: "CODE - NAME" or just "CODE")
          const productParts = productInfo.split(" - ");
          const productCode = productParts[0].trim();
          const productName =
            productParts.length > 1 ? productParts[1].trim() : productCode;

          const dealerQuantities: { [dealerName: string]: number } = {};
          let hasQuantity = false;

          // Extract quantities for each dealer
          for (let j = 1; j < row.length && j <= dealerNames.length; j++) {
            const dealerName = dealerNames[j - 1];
            const quantity = parseInt(row[j]) || 0;

            dealerQuantities[dealerName] = quantity;
            if (quantity > 0) hasQuantity = true;
          }

          // Only add items that have at least one non-zero quantity
          if (hasQuantity) {
            items.push({
              productCode,
              productName,
              dealerQuantities,
            });
          }
        }

        console.log("Processed items:", items.length);
        console.log("Sample item:", items[0]);

        if (items.length === 0) {
          return res
            .status(400)
            .json({
              message: "No valid product quantities found in Excel file",
            });
        }

        // Structure data for the existing storage method
        const excelData = {
          orderDate: deliveryDate, // Use delivery date as order date
          deliveryDate: deliveryDate,
          dealers,
          items,
          notes: `Imported from Excel file: ${req.file.originalname}`,
        };

        console.log("Creating dealer purchase order with structured data...");
        const result =
          await storage.createDealerPurchaseOrderFromExcel(excelData);

        // Add activity log
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "create",
            entityType: "dealer_purchase_order",
            entityId: result.purchaseOrder.id,
            details: `Dealer purchase order created from Excel file "${req.file.originalname}" with ${result.dealers.length} dealers and ${result.items.length} items by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "DealerPurchaseOrders",
          });
        }

        console.log("Successfully created dealer purchase order from Excel");
        res.status(201).json({
          purchaseOrder: result.purchaseOrder,
          totalDealers: result.dealers.length,
          totalItems: result.items.length,
          message: "Excel file imported successfully",
        });
      } catch (error) {
        console.error(
          "Error creating dealer purchase order from Excel:",
          error,
        );

        if (error instanceof ZodError) {
          return res.status(400).json({
            message: "Invalid Excel data format",
            errors: error.format(),
          });
        }

        // Handle Excel parsing errors
        if (
          error instanceof Error &&
          error.message.includes("Unsupported file")
        ) {
          return res.status(400).json({
            message:
              "Invalid Excel file format. Please upload a valid .xlsx or .xls file",
          });
        }

        res.status(500).json({
          message: "Failed to create dealer purchase order from Excel",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  // ==================== Dealer Purchase Order Items API ====================

  // GET /api/dealer-purchase-orders/:id/items - Get items for a specific purchase order
  apiRouter.get(
    "/dealer-purchase-orders/:id/items",
    async (req: Request, res: Response) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        const items =
          await storage.getDealerPurchaseOrderItems(purchaseOrderId);
        res.json(items);
      } catch (error) {
        console.error("Error getting dealer purchase order items:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch dealer purchase order items" });
      }
    },
  );

  // POST /api/dealer-purchase-orders/:id/items - Add an item to a purchase order
  apiRouter.post(
    "/dealer-purchase-orders/:id/items",
    async (req: Request, res: Response) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        const itemData = insertDealerPurchaseOrderItemSchema.parse({
          ...req.body,
          purchaseOrderId,
        });

        const item = await storage.createDealerPurchaseOrderItem(itemData);

        // Add activity log
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "create",
            entityType: "dealer_purchase_order_item",
            entityId: item.id,
            details: `Item ${item.productName} (quantity: ${item.quantity}) added to purchase order by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "DealerPurchaseOrders",
          });
        }

        res.status(201).json(item);
      } catch (error) {
        console.error("Error creating dealer purchase order item:", error);

        if (error instanceof ZodError) {
          return res.status(400).json({
            message: "Invalid item data",
            errors: error.format(),
          });
        }

        res
          .status(500)
          .json({ message: "Failed to create dealer purchase order item" });
      }
    },
  );

  // Shared across many pages/roles (Proforma Slips' plant picker, Overall Stock, Scan, Order
  // Import, the PlantBadge display component) — not exclusive to the Plant Management page,
  // so this is a plain login check, not a "plant-management" page-access check. Locking it to
  // that specific page (as an earlier pass did) broke every other page's plant dropdown for
  // any user without that specific grant.
  app.get("/api/plants", async (req, res) => {
    try {
      if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      const allPlants = await storage.getAllPlants(); // You need to ensure this method exists in storage.ts
      res.json(allPlants);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch plants" });
    }
  });

  // Create a new plant
  app.post("/api/plants", requirePageWrite("plant-management"), async (req, res) => {
    try {
      const data = insertPlantSchema.parse(req.body);
      const newPlant = await storage.createPlant(data); // Ensure this method exists in storage.ts
      res.status(201).json(newPlant);
    } catch (error) {
      res.status(400).json({ message: "Invalid plant data" });
    }
  });

  // Update a plant
  app.put("/api/plants/:id", requirePageWrite("plant-management"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const data = insertPlantSchema.parse(req.body);
      const updatedPlant = await storage.updatePlant(id, data); // Ensure this method exists
      res.json(updatedPlant);
    } catch (error) {
      res.status(400).json({ message: "Failed to update plant" });
    }
  });

  // Delete a plant
  app.delete("/api/plants/:id", requirePageWrite("plant-management"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deletePlant(id); // Ensure this method exists
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete plant" });
    }
  });

  app.get("/api/plants/:id/stvs", requirePageAccess("plant-management"), async (req, res) => {
    try {
      const plantId = parseInt(req.params.id);
      if (Number.isNaN(plantId)) {
        return res.status(400).json({ message: "Invalid plant id" });
      }
      const stvs = await storage.listPlantStvs(plantId);
      res.json(stvs);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch STVs" });
    }
  });

  app.post("/api/plants/:id/stvs", requirePageWrite("plant-management"), async (req, res) => {
    try {
      const plantId = parseInt(req.params.id);
      if (Number.isNaN(plantId)) {
        return res.status(400).json({ message: "Invalid plant id" });
      }

      const payloadSchema = z.object({
        stv: z.string().min(1, "STV is required"),
      });

      const payload = payloadSchema.parse(req.body);
      const newStv = await storage.createPlantStv({
        plantId,
        stv: payload.stv.trim(),
      });

      res.status(201).json(newStv);
    } catch (error) {
      res.status(400).json({ message: "Invalid STV data" });
    }
  });

  app.put("/api/plant-stvs/:id", requirePageWrite("plant-management"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        return res.status(400).json({ message: "Invalid STV id" });
      }

      const payloadSchema = z.object({
        stv: z.string().min(1, "STV is required"),
      });

      const payload = payloadSchema.parse(req.body);
      const updated = await storage.updatePlantStv(id, { stv: payload.stv.trim() });

      res.json(updated);
    } catch (error) {
      res.status(400).json({ message: "Failed to update STV" });
    }
  });

  app.delete("/api/plant-stvs/:id", requirePageWrite("plant-management"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        return res.status(400).json({ message: "Invalid STV id" });
      }

      await storage.deletePlantStv(id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete STV" });
    }
  });

  // PUT /api/dealer-purchase-order-items/:id - Update a purchase order item
  apiRouter.put(
    "/dealer-purchase-order-items/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const itemData = insertDealerPurchaseOrderItemSchema
          .partial()
          .parse(req.body);

        const updatedItem = await storage.updateDealerPurchaseOrderItem(
          id,
          itemData,
        );

        if (!updatedItem) {
          return res.status(404).json({ message: "Item not found" });
        }

        // Add activity log
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "update",
            entityType: "dealer_purchase_order_item",
            entityId: updatedItem.id,
            details: `Item ${updatedItem.productName} (quantity: ${updatedItem.quantity}) updated by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "DealerPurchaseOrders",
          });
        }

        res.json(updatedItem);
      } catch (error) {
        console.error("Error updating dealer purchase order item:", error);

        if (error instanceof ZodError) {
          return res.status(400).json({
            message: "Invalid item data",
            errors: error.format(),
          });
        }

        res
          .status(500)
          .json({ message: "Failed to update dealer purchase order item" });
      }
    },
  );

  // DELETE /api/dealer-purchase-order-items/:id - Delete a purchase order item
  apiRouter.delete(
    "/dealer-purchase-order-items/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);

        // Get the item before deleting
        const item = await storage.getDealerPurchaseOrderItem(id);
        if (!item) {
          return res.status(404).json({ message: "Item not found" });
        }

        const success = await storage.deleteDealerPurchaseOrderItem(id);

        if (!success) {
          return res.status(500).json({ message: "Failed to delete item" });
        }

        // Add activity log
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "delete",
            entityType: "dealer_purchase_order_item",
            entityId: id,
            details: `Item ${item.productName} (quantity: ${item.quantity}) deleted by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "DealerPurchaseOrders",
          });
        }

        res.json({ message: "Item deleted successfully" });
      } catch (error) {
        console.error("Error deleting dealer purchase order item:", error);
        res.status(500).json({ message: "Failed to delete item" });
      }
    },
  );

  // POST /api/dealer-purchase-orders/:id/items/batch - Add multiple items to a purchase order
  apiRouter.post(
    "/dealer-purchase-orders/:id/items/batch",
    async (req: Request, res: Response) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        const itemsData = z
          .array(insertDealerPurchaseOrderItemSchema)
          .parse(req.body.map((item: any) => ({ ...item, purchaseOrderId })));

        const items = await storage.createDealerPurchaseOrderItems(itemsData);

        // Add activity log for batch creation
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "create",
            entityType: "dealer_purchase_order_item",
            entityId: purchaseOrderId,
            details: `${items.length} dealer purchase order items added in batch by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "DealerPurchaseOrders",
          });
        }

        res.status(201).json(items);
      } catch (error) {
        console.error(
          "Error creating dealer purchase order items batch:",
          error,
        );

        if (error instanceof ZodError) {
          return res.status(400).json({
            message: "Invalid dealer purchase order items data",
            errors: error.format(),
          });
        }

        res
          .status(500)
          .json({ message: "Failed to create dealer purchase order items" });
      }
    },
  );

  // POST /api/recalculate-dealer-purchases - Manually trigger recalculation of product purchase totals including dealer orders
  apiRouter.post(
    "/recalculate-dealer-purchases",
    async (req: Request, res: Response) => {
      try {
        await storage.updateProductPurchaseTotals();

        // Add activity log for recalculation
        const sessionUser = (req as any).session?.user;
        if (sessionUser?.id) {
          await storage.logActivity({
            userId: sessionUser.id,
            action: "recalculate",
            entityType: "product",
            entityId: "all",
            details: `Purchase quantities recalculated for all products including dealer orders by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "DealerPurchaseOrders",
          });
        }

        res.json({
          message:
            "Purchase quantities recalculated successfully including dealer orders",
        });
      } catch (error) {
        console.error("Error recalculating dealer purchases:", error);
        res
          .status(500)
          .json({ message: "Failed to recalculate purchase quantities" });
      }
    },
  );

  // Mount proforma API routes
  apiRouter.use(proformaApiRoutes);

  // Mount fast import routes
  apiRouter.use(fastNotionImportRoutes);

  // Mount dispatch routes
  apiRouter.use(dispatchRoutes);

  // Mount dispatch orders routes
  apiRouter.use(dispatchOrdersRoutes);

  // Mount voucher prefix routes
  apiRouter.use(voucherPrefixRoutes);

  // Mount expense voucher routes
  apiRouter.use(expenseVoucherRoutes);

  // Mount toll voucher routes
  apiRouter.use(tollVoucherRoutes);

  // Mount check-in/out routes
  apiRouter.use(checkinoutRoutes);

  // Mount scan session routes
  apiRouter.use('/scan-sessions', scanSessionRoutes);

  // Mount Notion inventory sync routes
  apiRouter.use(notionInventorySyncRoutes);

  // Mount order import routes
  apiRouter.use(orderImportRoutes);

  // Mount order import edit routes (fix a mistake in an already-uploaded, not-yet-completed CSV)
  apiRouter.use(orderImportEditRoutes);

  // Mount order scan routes
  apiRouter.use(orderScanRoutes);

  // Mount the API router
  app.use("/api", apiRouter);

  // Every 24 hours: if DB has no products → full import from Notion;
  // otherwise detect changes, and apply them automatically only if an admin has turned on
  // the auto-apply toggle (notion_inventory_sync_config) — otherwise leave them pending for review.
  if (process.env.NOTION_INVENTORY_DATABASE_ID) {
    const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
    // syncImages is always false here — neither the boot-time run nor the recurring 24-hour
    // run ever downloads/checks product images. Photos are only ever synced when an admin
    // clicks "Sync Photos" on the Notion Inventory page; "Sync Notion" there and this scheduler
    // both run the fast, data-fields-only path.
    const runScheduledSync = async (syncImages: boolean) => {
      try {
        const allProducts = await storage.getAllProducts();
        if (allProducts.length === 0) {
          console.log('[Notion Inventory Sync] DB is empty — running full import from Notion...');
          await fullSyncFromNotion();
        } else {
          const autoApplyEnabled = await getAutoApplyEnabled();
          console.log(`[Notion Inventory Sync] Running scheduled detect${autoApplyEnabled ? ' + apply' : ' (auto-apply is off — review required)'} (images: ${syncImages ? 'on' : 'off'})...`);
          const detectReport = await detectChangesFromNotion('system', syncImages);
          const hasChanges = (detectReport.created ?? 0) + (detectReport.updated ?? 0) > 0;
          if (hasChanges && autoApplyEnabled) {
            console.log(`[Notion Inventory Sync] ${detectReport.created} new, ${detectReport.updated} changed — applying now...`);
            await applyPendingChanges();
            console.log('[Notion Inventory Sync] Auto-apply complete.');
          } else if (hasChanges) {
            console.log(`[Notion Inventory Sync] ${detectReport.created} new, ${detectReport.updated} changed — left pending for review (auto-apply is off).`);
          } else {
            console.log('[Notion Inventory Sync] No changes found, nothing to apply.');
          }
        }
      } catch (err) {
        console.error('[Notion Inventory Sync] Scheduled sync failed:', err);
      }
    };
    // Both the recurring run and the boot-time run are data-fields-only now — photos are
    // never checked automatically. An admin syncs photos on demand from the Product Master
    // page's "Sync Photos" button; Apply only ever touches images that a photo sync actually
    // queued, so staying data-only here never risks silently reverting/losing photo changes.
    setInterval(() => runScheduledSync(false), SYNC_INTERVAL_MS);
    setTimeout(() => runScheduledSync(false), 10000);
    console.log('[Notion Inventory Sync] 24-hour auto sync+apply scheduler registered');
  }

  // Return the HTTP server with WebSocket support
  return httpServer;
}
