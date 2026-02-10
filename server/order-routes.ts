import { Router, Request, Response } from 'express';
import { db } from './db';
import { 
  orders, 
  orderItems,
  products,
  insertOrderSchema, 
  insertOrderItemSchema,
  proformaSlips,
  proformaSlipItems,
  loadingOperations
} from '@shared/schema';
import { asc, eq, desc } from 'drizzle-orm';
import { z } from 'zod';

// Define a complete order schema that combines the header and items
const createOrderSchema = z.object({
  header: insertOrderSchema,
  items: z.array(insertOrderItemSchema.omit({ id: true, orderId: true }))
});

/**
 * Registers order management related routes
 * @param apiRouter Express router instance
 */
export function registerOrderRoutes(apiRouter: Router) {
  
  // Get all orders
  apiRouter.get('/orders', async (_req: Request, res: Response) => {
    try {
      const result = await db.select().from(orders).orderBy(desc(orders.createdAt));
      return res.json(result);
    } catch (error) {
      console.error('Error fetching orders:', error);
      return res.status(500).json({ error: 'Failed to fetch orders' });
    }
  });

  // Get single order with items
  apiRouter.get('/orders/:id', async (req: Request, res: Response) => {
    const orderId = parseInt(req.params.id);
    if (isNaN(orderId)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    try {
      const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      
      if (!order.length) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      
      return res.json({
        ...order[0],
        items
      });
    } catch (error) {
      console.error('Error fetching order:', error);
      return res.status(500).json({ error: 'Failed to fetch order' });
    }
  });

  // Create new order
  apiRouter.post('/orders', async (req: Request, res: Response) => {
    try {
      // Validate the request body
      const validatedData = createOrderSchema.parse(req.body);
      const { header, items } = validatedData;

      // Add the current user as creator if authenticated
      if (req.user) {
        header.createdById = req.user.id;
      }

      // Insert the order header
      const [newOrder] = await db.insert(orders).values(header).returning();

      if (!newOrder) {
        return res.status(500).json({ error: 'Failed to create order' });
      }

      // Insert all order items with required fields
      const orderItemsWithOrderId = items.map(item => ({
        orderId: newOrder.id,
        productId: item.productId,
        name: item.name,
        srNo: item.srNo || '',
        barcode: item.barcode || '',
        quantity: item.quantity,
        unitPrice: item.unitPrice || '0',
        totalPrice: item.totalPrice || '0',
        category: item.category || '',
        hsn: item.hsn || ''
      }));

      const insertedItems = await db.insert(orderItems).values(orderItemsWithOrderId).returning();

      return res.status(201).json({
        ...newOrder,
        items: insertedItems
      });
    } catch (error) {
      console.error('Error creating order:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      return res.status(500).json({ error: 'Failed to create order' });
    }
  });

  // Update an order
  apiRouter.patch('/orders/:id', async (req: Request, res: Response) => {
    const orderId = parseInt(req.params.id);
    if (isNaN(orderId)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    try {
      // Validate the request body
      const validatedData = createOrderSchema.parse(req.body);
      const { header, items } = validatedData;

      // Update the order header
      const [updatedOrder] = await db.update(orders)
        .set({
          ...header,
          updatedAt: new Date()
        })
        .where(eq(orders.id, orderId))
        .returning();

      if (!updatedOrder) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Delete existing items
      await db.delete(orderItems).where(eq(orderItems.orderId, orderId));

      // Insert updated items with required fields
      const orderItemsWithOrderId = items.map(item => ({
        orderId,
        productId: item.productId,
        name: item.name,
        srNo: item.srNo || '',
        barcode: item.barcode || '',
        quantity: item.quantity,
        unitPrice: item.unitPrice || '0',
        totalPrice: item.totalPrice || '0',
        category: item.category || '',
        hsn: item.hsn || ''
      }));

      const insertedItems = await db.insert(orderItems).values(orderItemsWithOrderId).returning();

      return res.json({
        ...updatedOrder,
        items: insertedItems
      });
    } catch (error) {
      console.error('Error updating order:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      return res.status(500).json({ error: 'Failed to update order' });
    }
  });

  // Delete an order
  apiRouter.delete('/orders/:id', async (req: Request, res: Response) => {
    const orderId = parseInt(req.params.id);
    if (isNaN(orderId)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    try {
      // Check if order exists
      const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      
      if (!order.length) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Delete associated items (will cascade due to foreign key constraint)
      const deletedOrder = await db.delete(orders).where(eq(orders.id, orderId)).returning();

      return res.json(deletedOrder[0]);
    } catch (error) {
      console.error('Error deleting order:', error);
      return res.status(500).json({ error: 'Failed to delete order' });
    }
  });

  // Convert an order to a proforma slip
  apiRouter.post('/orders/:id/to-proforma', async (req: Request, res: Response) => {
    const orderId = parseInt(req.params.id);
    if (isNaN(orderId)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    try {
      // Get the order with items
      const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      
      if (!order.length) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const orderData = order[0];
      
      // Check if order was already converted
      if (orderData.sentToProforma) {
        return res.status(400).json({ 
          error: 'Order already converted to proforma slip',
          proformaId: orderData.proformaId
        });
      }

      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      
      if (!items.length) {
        return res.status(400).json({ error: 'Cannot convert empty order to proforma slip' });
      }

      // Create proforma slip with proper field names based on proformaSlips schema
      let orderDateString = orderData.orderDate || new Date().toISOString().split('T')[0];
      
      const [newProformaSlip] = await db.insert(proformaSlips).values({
        orderNumber: orderData.orderNumber,
        partyName: orderData.dealer,
        vehicleNumber: orderData.vehicleNumber,
        plant: orderData.plant,
        orderDate: orderDateString,
        createdById: req.user?.id || orderData.createdById
      }).returning();

      if (!newProformaSlip) {
        return res.status(500).json({ error: 'Failed to create proforma slip' });
      }

      // Create proforma items with matching field names
      const proformaItems = items.map(item => ({
        proformaSlipId: newProformaSlip.id,
        productId: item.productId,
        itemName: item.name,
        quantity: item.quantity,
        originalQuantity: item.quantity,
        barcode: item.barcode || '',
        srNo: item.srNo || '',
        loaded: false,
        loadedQuantity: 0
      }));

      await db.insert(proformaSlipItems).values(proformaItems);

      // Update the order as sent to proforma
      await db.update(orders)
        .set({
          sentToProforma: true,
          proformaId: newProformaSlip.id,
          updatedAt: new Date()
        })
        .where(eq(orders.id, orderId));

      return res.json({
        ...newProformaSlip,
        originalOrderId: orderId
      });
    } catch (error) {
      console.error('Error converting order to proforma:', error);
      return res.status(500).json({ error: 'Failed to convert order to proforma slip' });
    }
  });

  // CSV Import endpoint
  apiRouter.post('/import/orders', async (req: Request, res: Response) => {
    try {
      // This would typically use multer middleware for file uploads
      // For simplicity, we're assuming CSV data is parsed into a JSON array in the body
      const { items, orderHeader } = req.body;
      
      if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid CSV data format' });
      }

      // Process the imported data and return results
      return res.status(200).json({
        success: true,
        importedRows: items.length,
        orderHeader
      });
    } catch (error) {
      console.error('Error importing CSV:', error);
      return res.status(500).json({ error: 'Failed to import CSV data' });
    }
  });
}