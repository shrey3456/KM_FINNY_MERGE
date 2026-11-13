import express, {
  type Express,
  Request,
  Response,
  NextFunction,
} from "express";
import { createServer, type Server } from "http";
import axios from "axios";
import { stateSapOf, anyStateSap } from "./lib/productSap";
import { stateOfPlant } from "./lib/stockV2";
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
  insertPurchaseSchema,
  insertPurchaseOrderSchema,
  insertPurchaseOrderItemSchema,
  insertUserSchema,
  insertProformaSlipSchema,
  insertProformaSlipItemSchema,
  insertMessageSchema,
  Product,
  ProformaSlip,
  ProformaSlipItem,
  Message,
  InsertProformaSlipItem,
} from "@shared/schema";
import { db, pool } from "./db";
import { eq, isNotNull } from "drizzle-orm";
import { ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { z } from "zod";
import multer from "multer";
import csv from "csv-parser";
import { Readable } from "stream";
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
import proformaNotionSyncRoutes from "./routes/proforma-notion-sync";
import notionWebhookRoutes from "./routes/notion-webhook";
import homeSlidesRoutes from "./routes/home-slides";
import dispatchRoutes from "./routes/dispatch-simple";
import dispatchOrdersRoutes from "./routes/dispatch-orders";
import expenseVoucherRoutes from "./routes/expense-voucher";
import tollVoucherRoutes from "./routes/toll-voucher";
import voucherPrefixRoutes from "./routes/voucher-prefix";
import scanSessionRoutes from "./routes/scan-sessions";
import notionInventorySyncRoutes from "./routes/notion-inventory-sync";
import vehicleInfoRoutes from "./routes/vehicle-info";
import loadingRoutes from "./routes/loading";
import vehiclePlanningRoutes from "./routes/vehicle-planning";
import driverMasterRoutes from "./routes/driver-master";
import sortSlipRoutes from "./routes/sort-slips";
import loadingCsvUploadRoutes from "./routes/loading-csv-upload";
import dailyReportsRoutes from "./routes/daily-reports";
import orderImportRoutes from "./routes/order-import";
import orderImportEditRoutes from "./routes/order-import-edit";
import unloadingEditRoutes from "./routes/unloading-edit";
import orderScanRoutes, { initOrderScanWs } from "./routes/order-scan";
import settingsAdminRoutes from "./routes/settings-admin";
import unloadingRoutes from "./routes/unloading";
import openingStockRoutes from "./routes/opening-stock";
import stockV2Routes from "./routes/stock-v2";
import { detectChangesFromNotion, fullSyncFromNotion, applyPendingChanges, getAutoApplyEnabled } from "./services/notionInventorySync";
import userRoutes from "./routes/users";
import { requirePageWrite, requirePageAccess } from "./lib/pageAccess";

// Builds the proforma-slips CSV export (one row per line item, snapshot fields only — never
// re-fetches product data, so the export stays correct even if a product was later edited or
// deleted) for whatever set of slips the caller has already selected/filtered. Shared by the
// GET (query-param filters) and POST (arbitrary id list, for a client-side-filtered view too
// large to fit in a query string) export routes so both produce identical output.
async function buildProformaSlipsCsv(
  filteredSlips: ProformaSlip[],
  summaryText: string,
  filenameSuffix: string,
): Promise<{ csv: string; filename: string }> {
  const csvRows: any[] = [];
  let totalVolumeSum = 0;

  for (const slip of filteredSlips) {
    if (slip.totalVolume && !isNaN(parseFloat(slip.totalVolume))) {
      totalVolumeSum += parseFloat(slip.totalVolume);
    }

    const slipItems = await storage.getProformaSlipItems(slip.id);

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
      // IMPORTANT: Use ONLY snapshot data from item to ensure immutability — DO NOT fetch
      // product data, proforma slips must remain unchanged even if inventory is edited/deleted.
      for (const item of slipItems) {
        csvRows.push({
          orderNumber: slip.orderNumber,
          orderDate: slip.orderDate ? new Date(slip.orderDate).toISOString().split("T")[0] : "",
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

  let csv = `"${summaryText}","${totalVolumeSum.toFixed(2)}"\n\n`;

  if (csvRows.length > 0) {
    const headers = Object.keys(csvRows[0]);
    csv += headers.join(",") + "\n";
    csvRows.forEach((row) => {
      const values = headers.map((header) => {
        const value = row[header]?.toString().replace(/,/g, ";") || "";
        return `"${value}"`;
      });
      csv += values.join(",") + "\n";
    });
  }

  return { csv, filename: `proforma-slips-${filenameSuffix}` };
}

// The SAP a slip item shows: the product's SAP for the slip's plant state (blank when it has none there - no general SAP any more).
async function slipItemSap(slipId: number | null | undefined, product: any): Promise<string | null> {
  if (slipId != null) {
    const { rows } = await pool.query(`SELECT plant FROM proforma_slips WHERE id = $1`, [slipId]);
    if (rows[0]) return stateSapOf(product, await stateOfPlant(pool, rows[0].plant ?? ""));
  }
  return anyStateSap(product);
}

// A table whose id counter fell behind its rows (rows loaded with explicit ids) fails every insert with a duplicate key on the primary key. This moves the
// counter to the highest id so the next insert works; the create routes below use it once, then try again.
async function resyncIdSequence(table: "plants" | "plant_stvs") {
  await pool.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`, [table]);
}
const isPrimaryKeyDuplicate = (e: any) => e?.code === "23505" && /_pkey$/.test(String(e?.constraint ?? ""));

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
      // Shared across many pages/roles (Scan's Edit CSV search, Stock Overview's Exchange
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
      // Optional — only matters when this barcode has more than one Product Master row (see
      // getProductByBarcode's own comment). Without it, a shared barcode falls back to
      // whichever row the query happens to return first, which is how Order Scan/Loading/
      // Unloading's own barcode lookups kept picking the wrong row's pallet size even after the
      // main /scan endpoints were fixed to pass plant through.
      const plant = typeof req.query.plant === 'string' ? req.query.plant : undefined;
      let product = await storage.getProductByBarcode(barcode, plant);

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
        // ids: comma-separated proforma_slips.id list — sent by the client when the table has
        // an active search / plant tab / date range / column filter applied, so the export
        // matches exactly what's on screen instead of always dumping every slip in the table
        // regardless of what's currently filtered.
        const idsParam = req.query.ids as string | undefined;
        const idsFilter = idsParam
          ? new Set(idsParam.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n)))
          : null;

        // Get all proforma slips with very high limit for no practical limitation
        const slips = await storage.listProformaSlips(100000, 0);

        if (!slips || slips.length === 0) {
          return res.status(404).json({ error: "No proforma slips found" });
        }

        // Filter slips by date if provided
        let filteredSlips = idsFilter ? slips.filter((slip) => idsFilter.has(slip.id)) : slips;
        let dateFilter = "";

        if (idsFilter) {
          dateFilter = "filtered-view";
          console.log(`Exporting ${filteredSlips.length} slips matching the current on-screen filter (${idsFilter.size} ids requested)`);
        } else if (startDate && endDate) {
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

        // Total volume summary label + filename suffix, covering the ids-filter case too.
        let summaryText: string;
        let filenameSuffix: string;
        if (idsFilter) {
          summaryText = "Total Volume Sum for the current filtered view";
          filenameSuffix = "filtered-view";
        } else if (startDate && endDate) {
          summaryText = `Total Volume Sum for date range ${startDate} to ${endDate}`;
          filenameSuffix = `${startDate}-to-${endDate}`;
        } else if (filterDate) {
          summaryText = `Total Volume Sum for ${dateFilter}`;
          filenameSuffix = dateFilter;
        } else {
          summaryText = "Total Volume Sum for all dates";
          filenameSuffix = "all-dates";
        }

        const { csv, filename } = await buildProformaSlipsCsv(filteredSlips, summaryText, filenameSuffix);

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
              const defaultUserId = users.length > 0 ? users[0].userCode : null;

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
                createdByCode: defaultUserId,
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

      // One slip per order number — this had no check at all before, so creating one twice for
      // the same order (a double-click, or a second manual entry) silently produced two separate
      // proforma_slips rows, which then showed as a duplicate everywhere downstream (Loading's
      // list, etc). Must delete the existing one first to create a fresh one for this order.
      if (slipData.orderNumber) {
        const existing = await storage.getProformaSlipByOrderNumber(slipData.orderNumber);
        if (existing) {
          return res.status(409).json({
            message: `A proforma slip for order ${slipData.orderNumber} already exists (#${existing.id}). Delete it first before creating a new one.`,
          });
        }
      }

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

        // The slip's own rows, exactly as stored — Print Operations prints the proforma slip as it
        // was imported, not a re-read of Product Master. This used to overwrite each item's name
        // and Sr. No. with the product's CURRENT values whenever the item had a productId, so a
        // product renamed or renumbered later in Notion changed old slips when they were printed,
        // and items with no productId came out different again. proforma_slip_items already
        // stores a snapshot of every printed field for exactly this reason (see its schema
        // comment: "display always uses snapshot fields"). `sku` is kept for older callers and is
        // the slip's own barcode.
        const snapshotItems = items.map((item) => ({ ...item, sku: item.barcode }));

        res.json({
          slip,
          items: snapshotItems,
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
          req.user?.userCode ||
          updatedSlip.createdByCode ||
          existingSlip.createdByCode;
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
          userCode: userId || null,
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
          // The signed-in user (passport puts them on req.user) — req.session.user is never set, so
          // this used to fall back to whoever CREATED the slip and log the delete under their name.
          const actingUser = req.user as any;
          const userId = actingUser?.id ?? null;
          const userName = actingUser?.name || actingUser?.username || actingUser?.userCode || "Unknown User";

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
            userCode: actingUser?.userCode ?? null,
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
          if (!itemData.sapCode) {
            const sap = await slipItemSap((itemData as any).proformaSlipId, product);
            if (sap) itemData.sapCode = sap;
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

        // Editing the SKU — an explicit "this line is actually a different product" swap, sent
        // as a new productId. Unlike creation (which only fills snapshot fields left blank),
        // this OVERWRITES every snapshot field from the new product, since the whole point is to
        // correct a wrong SKU everywhere the slip reads it (printing, Loading's barcode matching,
        // reports) — not just the productId pointer. Quantity is untouched; it's set independently.
        if (itemData.productId && itemData.productId !== existingItem.productId) {
          const newProduct = await storage.getProduct(itemData.productId);
          if (!newProduct) {
            return res.status(400).json({ message: "Referenced product does not exist" });
          }
          itemData.itemName = newProduct.name ?? null;
          itemData.barcode = newProduct.barcode ?? null;
          itemData.srNo = newProduct.newSr ?? null;
          itemData.itemNo = newProduct.itemNo ?? null;
          itemData.category = newProduct.category ?? null;
          itemData.volumeInCuFt = newProduct.volumeInCuFt ?? null;
          itemData.hsnCode = newProduct.hsnCode ?? null;
          itemData.sapCode = await slipItemSap(existingItem.proformaSlipId, newProduct);
          itemData.description = newProduct.description ?? null;
          itemData.purchasePrice = newProduct.purchasePrice ?? null;
          itemData.sellingPrice = newProduct.sellingPrice ?? null;
        }

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
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Vehicle Info / Vehicle Master endpoints moved to server/routes/vehicle-info.ts (mounted
  // below via apiRouter.use(vehicleInfoRoutes)) — was previously six unauthenticated handlers
  // inline here, now a protected, self-contained router.

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
        const sessionUser = req.user;
        if (sessionUser?.userCode) {
          await storage.logActivity({
            userCode: sessionUser.userCode,
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
        const sessionUser = req.user;
        if (sessionUser?.userCode) {
          await storage.logActivity({
            userCode: sessionUser.userCode,
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
        const sessionUser = req.user;
        if (sessionUser?.userCode) {
          await storage.logActivity({
            userCode: sessionUser.userCode,
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
        const sessionUser = req.user;
        if (sessionUser?.userCode) {
          await storage.logActivity({
            userCode: sessionUser.userCode,
            action: "create",
            entityType: "dealer_purchase_order",
            entityId: result.purchaseOrder.id,
            details: `Dealer purchase order created from Excel file "${req.file.originalname}" with ${excelData.dealers.length} dealers and ${result.items.length} items by ${sessionUser.name || sessionUser.username || "Unknown user"}`,
            pageName: "DealerPurchaseOrders",
          });
        }

        console.log("Successfully created dealer purchase order from Excel");
        res.status(201).json({
          purchaseOrder: result.purchaseOrder,
          totalDealers: excelData.dealers.length,
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
        const itemData = insertPurchaseOrderItemSchema.parse({
          ...req.body,
          purchaseOrderId,
        });

        const item = await storage.createDealerPurchaseOrderItem(itemData);

        // Add activity log
        const sessionUser = req.user;
        if (sessionUser?.userCode) {
          await storage.logActivity({
            userCode: sessionUser.userCode,
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

  // Shared across many pages/roles (Proforma Slips' plant picker, Stock Overview, Scan, Order
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
    let data;
    try {
      data = insertPlantSchema.parse(req.body);
    } catch (error) {
      console.error("Create plant validation error:", error);
      return res.status(400).json({ message: "Invalid plant data" });
    }
    try {
      let newPlant;
      try {
        newPlant = await storage.createPlant(data); // Ensure this method exists in storage.ts
      } catch (error) {
        if (!isPrimaryKeyDuplicate(error)) throw error;
        await resyncIdSequence("plants");
        newPlant = await storage.createPlant(data);
      }
      res.status(201).json(newPlant);
    } catch (error) {
      // The insert may have already committed before this throws (e.g. a slow/dropped
      // connection on the response write) — that's a server-side failure, not a client
      // validation error, so it must not be reported as a 400.
      console.error("Create plant error:", error);
      res.status(500).json({ message: "Failed to create plant" });
    }
  });

  // Update a plant
  app.put("/api/plants/:id", requirePageWrite("plant-management"), async (req, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid plant id" });
    }
    let data;
    try {
      data = insertPlantSchema.parse(req.body);
    } catch (error) {
      console.error("Update plant validation error:", error);
      return res.status(400).json({ message: "Invalid plant data" });
    }
    try {
      const updatedPlant = await storage.updatePlant(id, data); // Ensure this method exists
      res.json(updatedPlant);
    } catch (error) {
      // Same reasoning as the create route above: an error thrown after the update already
      // committed is a server-side failure, not a client validation error, so it must not be
      // reported as a 400.
      console.error("Update plant error:", error);
      res.status(500).json({ message: "Failed to update plant" });
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
      // Natural order (PLT1, PLT2, … PLT10) — same as the dropdowns that read these.
      stvs.sort((a: any, b: any) => String(a.stv).localeCompare(String(b.stv), undefined, { numeric: true, sensitivity: "base" }));
      res.json(stvs);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch Dispatch Directories" });
    }
  });

  app.post("/api/plants/:id/stvs", requirePageWrite("plant-management"), async (req, res) => {
    try {
      const plantId = parseInt(req.params.id);
      if (Number.isNaN(plantId)) {
        return res.status(400).json({ message: "Invalid plant id" });
      }

      const payloadSchema = z.object({
        stv: z.string().min(1, "Dispatch Directory is required"),
      });

      const parsed = payloadSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid Dispatch Directory data" });
      const values = { plantId, stv: parsed.data.stv.trim() };
      let newStv;
      try {
        newStv = await storage.createPlantStv(values);
      } catch (error) {
        if (!isPrimaryKeyDuplicate(error)) throw error;
        await resyncIdSequence("plant_stvs");
        newStv = await storage.createPlantStv(values);
      }

      res.status(201).json(newStv);
    } catch (error) {
      // Only a bad payload is a 400 (above); a database failure used to be reported as "Invalid Dispatch Directory data" too, which hid the real cause.
      console.error("Create Dispatch Directory error:", error);
      res.status(500).json({ message: "Failed to create the Dispatch Directory" });
    }
  });

  app.put("/api/plant-stvs/:id", requirePageWrite("plant-management"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        return res.status(400).json({ message: "Invalid Dispatch Directory id" });
      }

      const payloadSchema = z.object({
        stv: z.string().min(1, "Dispatch Directory is required"),
      });

      const payload = payloadSchema.parse(req.body);
      const updated = await storage.updatePlantStv(id, { stv: payload.stv.trim() });

      res.json(updated);
    } catch (error) {
      res.status(400).json({ message: "Failed to update Dispatch Directory" });
    }
  });

  app.delete("/api/plant-stvs/:id", requirePageWrite("plant-management"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        return res.status(400).json({ message: "Invalid Dispatch Directory id" });
      }

      await storage.deletePlantStv(id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete Dispatch Directory" });
    }
  });

  // PUT /api/dealer-purchase-order-items/:id - Update a purchase order item
  apiRouter.put(
    "/dealer-purchase-order-items/:id",
    async (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        const itemData = insertPurchaseOrderItemSchema
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
        const sessionUser = req.user;
        if (sessionUser?.userCode) {
          await storage.logActivity({
            userCode: sessionUser.userCode,
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
        const sessionUser = req.user;
        if (sessionUser?.userCode) {
          await storage.logActivity({
            userCode: sessionUser.userCode,
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
          .array(insertPurchaseOrderItemSchema)
          .parse(req.body.map((item: any) => ({ ...item, purchaseOrderId })));

        const items = await storage.createDealerPurchaseOrderItems(itemsData);

        // Add activity log for batch creation
        const sessionUser = req.user;
        if (sessionUser?.userCode) {
          await storage.logActivity({
            userCode: sessionUser.userCode,
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

  // Mount proforma API routes
  apiRouter.use(proformaApiRoutes);

  // Mount fast import routes
  apiRouter.use(fastNotionImportRoutes);
  apiRouter.use(proformaNotionSyncRoutes);
  // Notion calls this when a page changes (status, vehicles, products) — see routes/notion-webhook.ts.
  apiRouter.use(notionWebhookRoutes);
  // Dashboard slider + Login welcome photo, copied from the Notion attachment database.
  apiRouter.use(homeSlidesRoutes);

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

  // Mount scan session routes
  apiRouter.use('/scan-sessions', scanSessionRoutes);

  // Mount Notion inventory sync routes
  apiRouter.use(notionInventorySyncRoutes);

  // Mount Vehicle Master (vehicle_info CRUD + Notion vehicle sync) routes
  apiRouter.use(vehicleInfoRoutes);
  
  // Driver Master (the Notion drivers kept in our own table)
  apiRouter.use(driverMasterRoutes);

  // Mount Loading routes (link a Vehicle Master vehicle onto a Proforma Slip) — new feature,
  // own file, no dependency on the legacy Load Operations routes.
  apiRouter.use(loadingRoutes);

  // Vehicle Planning — Gantt-style fleet scheduling view, own file. Test-mode restricted on its
  // own write action (see TEST_MODE_ORDER_NUMBERS in that file) — remove that guard once trusted.
  apiRouter.use(vehiclePlanningRoutes);

  // Sort Slip — godown picking. Deliberately separate from Loading above: it shares only the
  // order number, writes only its own tables, and moves no stock (see server/routes/sort-slips.ts).
  apiRouter.use(sortSlipRoutes);
  apiRouter.use(loadingCsvUploadRoutes);
  apiRouter.use(dailyReportsRoutes);

  // Mount order import routes
  apiRouter.use(orderImportRoutes);

  // Mount order import edit routes (fix a mistake in an already-uploaded, not-yet-completed CSV)
  apiRouter.use(orderImportEditRoutes);

  // Mount unloading edit routes (same idea, for an unloading vehicle's CSV)
  apiRouter.use(unloadingEditRoutes);

  // Mount order scan routes
  apiRouter.use(orderScanRoutes);

  // Mount Settings > Clear Stock admin routes
  apiRouter.use(settingsAdminRoutes);

  // Stock Overview — the report, the per-line drill-down and the admin actions (Adjust / Clear / Delete history), Opening stock
  apiRouter.use(stockV2Routes);

  // Mount Unloading routes (vehicle-wise receiving)
  apiRouter.use(unloadingRoutes);

  // Mount Settings > Opening Stock import routes
  apiRouter.use(openingStockRoutes);

  // Mount the API router
  app.use("/api", apiRouter);

  // Every 24 hours: if DB has no products → full import from Notion;
  // otherwise detect changes, and apply them automatically only if an admin has turned on
  // the auto-apply toggle (notion_inventory_sync_config) — otherwise leave them pending for review.
  if (process.env.NOTION_PRODUCTS_MASTER_DATABASE_ID) {
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
    // On boot, only import if the DB is empty — otherwise every deploy/restart would re-run a
    // full Notion detect. Non-empty DBs wait for the regular 24-hour run.
    setTimeout(async () => {
      const { rowCount } = await pool.query('SELECT 1 FROM products LIMIT 1');
      if (!rowCount) runScheduledSync(false);
    }, 10000);
    console.log('[Notion Inventory Sync] 24-hour auto sync+apply scheduler registered');
  }

  // Same 24-hour detect(+apply-if-enabled) scheduler as Product Master above, for Vehicle
  // Master. No image work here (vehicle_info has no photo column), so there's no syncImages
  // split — every run is the same shape.
  if (process.env.NOTION_VEHICLE_DATABASE_ID) {
    const { detectVehicleChangesFromNotion, applyPendingVehicleChanges, fullSyncVehiclesFromNotion, getAutoApplyEnabled: getVehicleAutoApplyEnabled } =
      await import('./services/notionVehicleSync');
    const VEHICLE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const runScheduledVehicleSync = async () => {
      try {
        const allVehicles = await storage.getAllVehicleInfo();
        if (allVehicles.length === 0) {
          console.log('[Notion Vehicle Sync] DB is empty — running full import from Notion...');
          await fullSyncVehiclesFromNotion('system', null);
        } else {
          const autoApplyEnabled = await getVehicleAutoApplyEnabled();
          console.log(`[Notion Vehicle Sync] Running scheduled detect${autoApplyEnabled ? ' + apply' : ' (auto-apply is off — review required)'}...`);
          const detectReport = await detectVehicleChangesFromNotion('system');
          const hasChanges = (detectReport.created ?? 0) + (detectReport.updated ?? 0) > 0;
          if (hasChanges && autoApplyEnabled) {
            console.log(`[Notion Vehicle Sync] ${detectReport.created} new, ${detectReport.updated} changed — applying now...`);
            await applyPendingVehicleChanges(null);
            console.log('[Notion Vehicle Sync] Auto-apply complete.');
          } else if (hasChanges) {
            console.log(`[Notion Vehicle Sync] ${detectReport.created} new, ${detectReport.updated} changed — left pending for review (auto-apply is off).`);
          } else {
            console.log('[Notion Vehicle Sync] No changes found, nothing to apply.');
          }
        }
      } catch (err) {
        console.error('[Notion Vehicle Sync] Scheduled sync failed:', err);
      }
    };
    setInterval(() => runScheduledVehicleSync(), VEHICLE_SYNC_INTERVAL_MS);
    setTimeout(async () => {
      const { rowCount } = await pool.query('SELECT 1 FROM vehicle_info LIMIT 1');
      if (!rowCount) runScheduledVehicleSync();
    }, 15000);
    console.log('[Notion Vehicle Sync] 24-hour auto sync+apply scheduler registered');
  }

  // Every 5 hours: detect Proforma Slip changes from Notion for TODAY (local date), and apply
  // them automatically only if an admin has turned on the auto-apply toggle
  // (proforma_sync_config) — otherwise leave them pending for review, same gating as Product/
  // Vehicle Master above. Reuses the exact same detect/apply pair the "Sync from Notion" dialog
  // on the Proforma Slips page calls manually (server/services/proformaNotionSync.ts), so a
  // scheduled run and a manual one behave identically and share the same pending-review state.
  if (process.env.NOTION_PROFORMA_DATABASE_ID && process.env.NOTION_ORDER_DATABASE_ID) {
    const { syncLatestDateFromOrderDb, getAutoApplyEnabled: getProformaAutoApplyEnabled, logProformaSync } = await import('./services/proformaNotionSync');
    const PROFORMA_SYNC_INTERVAL_MS = 5 * 60 * 60 * 1000;
    // Refreshes only the latest order date's existing slips from the Notion Order DB.
    const runScheduledProformaSync = async (trigger: string) => {
      try {
        // Auto-apply toggle off: nothing is written, the run only reports what would change.
        const apply = await getProformaAutoApplyEnabled();
        const r = await syncLatestDateFromOrderDb(apply);
        console.log(r.date
          ? `[Proforma Sync] ${r.date}: checked ${r.checked} existing slip(s), ${apply ? `updated ${r.updated}` : `${r.updated} would change — NOT applied (auto-apply is off)`}.`
          : '[Proforma Sync] No slips yet, nothing to sync.');
        // One Activities line per run: the scheduled job reads Notion (it never creates slips) — so the log says what it read and what it did.
        void logProformaSync(
          r.date
            ? `Scheduled Notion sync (Proforma Slips, ${trigger}): order date ${r.date} — ${r.checked} existing slip(s) checked, 0 created, ${apply ? `${r.updated} updated` : `${r.updated} would change but nothing was written (auto-apply is off)`}`
            : `Scheduled Notion sync (Proforma Slips, ${trigger}): no slips yet, nothing to sync`,
        );
      } catch (err) {
        console.error('[Proforma Sync] Scheduled sync failed:', err);
        void logProformaSync(`Scheduled Notion sync (Proforma Slips, ${trigger}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    setInterval(() => runScheduledProformaSync('every 5 hours'), PROFORMA_SYNC_INTERVAL_MS);
    setTimeout(() => runScheduledProformaSync('after server start'), 20000);
    console.log('[Proforma Sync] 5-hour auto sync scheduler registered');
  }

  // Daily Notion sync (Settings > Data Management): once a day at the admin's set time (India time) - Product Master, 5 minutes later tomorrow's Proforma
  // Slips. One timer when switched on, none when off; separate from the 5-hour scheduler above. See server/services/dailyNotionSync.ts.
  try {
    const { startDailyNotionSync } = await import('./services/dailyNotionSync');
    await startDailyNotionSync();
  } catch (err) {
    console.error('[Daily Notion Sync] Could not start:', err);
  }

  // Auto Dispatch: a load started after this went live becomes Dispatched by itself an hour after it was completed (app and Notion) - see
  // server/services/autoDispatch.ts. It reads the database every few minutes, so a restart never loses a dispatch.
  const { startAutoDispatchScheduler } = await import('./services/autoDispatch');
  startAutoDispatchScheduler();

  // Return the HTTP server with WebSocket support
  return httpServer;
}
