import { Router, Request, Response } from 'express';
import { IStorage } from './storage';
import { z } from 'zod';
import { ZodError } from 'zod';
import { fromZodError } from 'zod-validation-error';

/**
 * Registers batch API routes for efficient data fetching
 * @param apiRouter Express router instance
 * @param storage Storage interface
 */
export function registerBatchRoutes(apiRouter: Router, storage: IStorage) {
  // Fetch multiple proforma slips in a single request - optimized version
  apiRouter.post("/proforma-slips/batch", async (req: Request, res: Response) => {
    try {
      // Validate request body with orderNumbers array
      const schema = z.object({
        orderNumbers: z.array(z.string()),
      });
      
      const { orderNumbers } = schema.parse(req.body);
      
      if (!orderNumbers || orderNumbers.length === 0) {
        return res.status(400).json({ message: "No order numbers provided" });
      }
      
      // Limit batch size to improve response time 
      const maxBatchSize = 50;
      const orderNumbersToProcess = orderNumbers.slice(0, maxBatchSize);
      
      if (orderNumbersToProcess.length < orderNumbers.length) {
        console.log(`Limiting batch to ${maxBatchSize} of ${orderNumbers.length} requested slips`);
      } else {
        console.log(`Batch fetching ${orderNumbersToProcess.length} proforma slips`);
      }
      
      // Create a result object to store proforma slip data by order number
      const result: Record<string, any> = {};
      
      // First get all the slips in a single query if possible
      let slipsMap: Record<string, any> = {};
      try {
        const slips = await storage.getProformaSlipsByOrderNumbers(orderNumbersToProcess);
        slipsMap = slips.reduce((acc: Record<string, any>, slip) => {
          if (slip.orderNumber) {
            acc[slip.orderNumber] = slip;
          }
          return acc;
        }, {});
      } catch (error) {
        console.error('Error batch fetching slips:', error);
        // Fall back to individual queries if bulk query fails
      }
      
      // Process order numbers in parallel with Promise.all but with smaller batch size
      const batchSize = 10;
      for (let i = 0; i < orderNumbersToProcess.length; i += batchSize) {
        const batch = orderNumbersToProcess.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (orderNumber) => {
          try {
            // Try to get the slip from the map first
            let slip = slipsMap[orderNumber];
            
            // If not in map, fetch individually
            if (!slip) {
              slip = await storage.getProformaSlipByOrderNumber(orderNumber);
            }
            
            if (!slip) {
              return;
            }
            
            // Fetch the items for this slip
            const items = await storage.getProformaSlipItems(slip.id);
            
            // Check if there's an existing operation for this order number
            const operation = await storage.getLoadingOperationByReferenceNumber(orderNumber);
            
            // Store the complete data in the result object
            result[orderNumber] = {
              slip,
              items: items || [],
              operation: operation || null,
            };
          } catch (error) {
            console.error(`Error fetching proforma slip for order #${orderNumber}:`, error);
            // Skip this order number on error
          }
        }));
      }
      
      console.log(`Successfully fetched ${Object.keys(result).length} of ${orderNumbersToProcess.length} requested proforma slips`);
      
      res.json(result);
    } catch (error) {
      console.error("Error in batch proforma slip fetch:", error);
      
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      
      res.status(500).json({ 
        message: "Failed to fetch proforma slips in batch",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
  
  // Batch fetch products by IDs
  apiRouter.post("/products/batch", async (req: Request, res: Response) => {
    try {
      // Validate request body with productIds array
      const schema = z.object({
        productIds: z.array(z.number()),
      });
      
      const { productIds } = schema.parse(req.body);
      
      if (!productIds || productIds.length === 0) {
        return res.status(400).json({ message: "No product IDs provided" });
      }
      
      // Set a reasonable limit on batch size
      const maxBatchSize = 100;
      const productIdsToProcess = productIds.slice(0, maxBatchSize);
      
      if (productIdsToProcess.length < productIds.length) {
        console.log(`Limiting batch to ${maxBatchSize} of ${productIds.length} requested products`);
      } else {
        console.log(`Batch fetching ${productIdsToProcess.length} products`);
      }
      
      // Fetch all products in a single database query
      const products = await storage.getProductsByIds(productIdsToProcess);
      
      // Create a map of products by ID for easy access
      const productMap: Record<number, any> = {};
      
      products.forEach(product => {
        productMap[product.id] = product;
      });
      
      console.log(`Successfully fetched ${products.length} of ${productIdsToProcess.length} requested products`);
      
      res.json(productMap);
    } catch (error) {
      console.error("Error in batch product fetch:", error);
      
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      
      res.status(500).json({ 
        message: "Failed to fetch products in batch",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
  
  // Batch update proforma slip items (loaded status and quantity)
  apiRouter.post("/proforma-items/batch-update", async (req: Request, res: Response) => {
    try {
      // Validate request body with items array to update
      const schema = z.object({
        items: z.array(z.object({
          id: z.number(),
          loaded: z.boolean().optional(),
          quantity: z.number().optional()
        }))
      });
      
      const { items } = schema.parse(req.body);
      
      if (!items || items.length === 0) {
        return res.status(400).json({ message: "No items provided for update" });
      }
      
      console.log(`Batch updating ${items.length} proforma slip items`);
      
      // Set a reasonable limit on batch size
      const maxBatchSize = 100;
      const itemsToProcess = items.slice(0, maxBatchSize);
      
      // Execute all item updates in parallel for maximum speed
      const updateResults = await Promise.all(itemsToProcess.map(async (item) => {
        try {
          const updateData: any = {};
          
          if (item.loaded !== undefined) {
            updateData.loaded = item.loaded;
          }
          
          if (item.quantity !== undefined) {
            updateData.quantity = item.quantity;
          }
          
          // Only update if there's data to update
          if (Object.keys(updateData).length > 0) {
            await storage.updateProformaSlipItem(item.id, updateData);
            return { id: item.id, success: true };
          }
          
          return { id: item.id, success: false, error: "No valid update fields provided" };
        } catch (error) {
          console.error(`Error updating item ${item.id}:`, error);
          return { 
            id: item.id, 
            success: false, 
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }));
      
      const successful = updateResults.filter(result => result.success).length;
      console.log(`Successfully updated ${successful} of ${itemsToProcess.length} items`);
      
      res.json({ 
        results: updateResults,
        summary: { 
          total: itemsToProcess.length,
          successful,
          failed: itemsToProcess.length - successful
        }
      });
    } catch (error) {
      console.error("Error in batch item update:", error);
      
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      
      res.status(500).json({ 
        message: "Failed to update items in batch",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
  
  // Add more batch endpoints as needed
}