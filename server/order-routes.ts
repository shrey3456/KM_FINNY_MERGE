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
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage() });

type CsvRow = string[];

type ParsedOrderItem = {
  productId?: number;
  srNo?: string;
  name: string;
  barcode?: string;
  quantity: number;
  sapCode?: string;
};

type ParsedOrder = {
  dealer: string;
  orderNumber: string;
  plant: string;
  vehicleNumber: string;
  orderDate: string;
  items: ParsedOrderItem[];
};

function parseCsvRows(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      value += '"';
      index++;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(value.trim().replace(/^\uFEFF/, ''));
      value = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        index++;
      }
      row.push(value.trim().replace(/^\uFEFF/, ''));
      if (row.some((cell) => cell !== '')) {
        rows.push(row);
      }
      row = [];
      value = '';
      continue;
    }

    value += char;
  }

  if (value || row.length > 0) {
    row.push(value.trim().replace(/^\uFEFF/, ''));
    if (row.some((cell) => cell !== '')) {
      rows.push(row);
    }
  }

  return rows;
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseProductDescriptor(descriptor: string) {
  const clean = descriptor.trim();
  const match = clean.match(/^(\d+)\s*-\s*(.+)$/);

  if (match) {
    return {
      sapCode: match[1],
      name: match[2].trim(),
    };
  }

  return {
    sapCode: clean.match(/\d{5,}/)?.[0],
    name: clean || 'Imported Product',
  };
}

function toQuantity(value: string | undefined) {
  const numericValue = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(numericValue) && numericValue > 0 ? Math.round(numericValue) : 0;
}

function buildProductLookup(productRows: Array<typeof products.$inferSelect>) {
  const bySap = new Map<string, typeof products.$inferSelect>();
  const byName = new Map<string, typeof products.$inferSelect>();

  productRows.forEach((product) => {
    if (product.sapCode) bySap.set(product.sapCode.trim(), product);
    byName.set(product.name.trim().toLowerCase(), product);
  });

  return { bySap, byName };
}

function matchProduct(
  item: { sapCode?: string; name: string },
  lookup: ReturnType<typeof buildProductLookup>,
) {
  if (item.sapCode && lookup.bySap.has(item.sapCode)) {
    return lookup.bySap.get(item.sapCode);
  }

  return lookup.byName.get(item.name.trim().toLowerCase());
}

function buildOrderNumber(prefix: string, orderDate: string, index: number) {
  return `${prefix}-${orderDate.replace(/-/g, '')}-${String(index + 1).padStart(3, '0')}`;
}

function parseArrivingOrdersCsv(
  rows: CsvRow[],
  productRows: Array<typeof products.$inferSelect>,
  options: { plant?: string; orderDate?: string },
): ParsedOrder[] {
  const lookup = buildProductLookup(productRows);
  const plant = options.plant?.trim() || 'Valsad';
  const orderDate = options.orderDate || new Date().toISOString().split('T')[0];

  if (rows.length < 2) return [];

  const firstRow = rows[0].map((cell) => cell.trim());
  const secondRow = rows[1]?.map((cell) => cell.trim()) || [];
  const firstCell = normalizeHeader(firstRow[0] || '');
  const secondCell = normalizeHeader(secondRow[0] || '');

  if (firstCell.includes('customer') && secondCell.includes('productcode')) {
    const dealerColumns = firstRow
      .map((dealer, index) => ({ dealer, index }))
      .filter(({ dealer, index }) => index > 0 && dealer && normalizeHeader(dealer) !== 'total');

    const ordersByDealer = new Map<string, ParsedOrder>();

    dealerColumns.forEach(({ dealer }, orderIndex) => {
      ordersByDealer.set(dealer, {
        dealer,
        orderNumber: buildOrderNumber('ARR', orderDate, orderIndex),
        plant,
        vehicleNumber: '',
        orderDate,
        items: [],
      });
    });

    rows.slice(2).forEach((row) => {
      const descriptor = row[0];
      if (!descriptor || normalizeHeader(descriptor).includes('grandtotal') || normalizeHeader(descriptor) === 'total') return;

      const parsedProduct = parseProductDescriptor(descriptor);

      dealerColumns.forEach(({ dealer, index }) => {
        const quantity = toQuantity(row[index]);
        if (!quantity) return;

        const product = matchProduct(parsedProduct, lookup);
        ordersByDealer.get(dealer)?.items.push({
          productId: product?.id,
          srNo: product?.srNo || '',
          name: product?.name || parsedProduct.name,
          barcode: product?.barcode || '',
          quantity,
          sapCode: parsedProduct.sapCode,
        });
      });
    });

    return Array.from(ordersByDealer.values()).filter((order) => order.items.length > 0);
  }

  const productHeaderRowIndex = rows.findIndex((row) =>
    row.some((cell) => normalizeHeader(cell).includes('productcode')),
  );
  const customerHeaderRowIndex = rows.findIndex((row) =>
    row.some((cell) => normalizeHeader(cell) === 'customer'),
  );

  if (productHeaderRowIndex >= 0 && customerHeaderRowIndex >= 0 && productHeaderRowIndex < customerHeaderRowIndex) {
    const productHeaderRow = rows[productHeaderRowIndex];
    const customerHeaderRow = rows[customerHeaderRowIndex];
    const productStartIndex = productHeaderRow.findIndex((cell) => normalizeHeader(cell).includes('productcode')) + 1;
    const customerColumnIndex = customerHeaderRow.findIndex((cell) => normalizeHeader(cell) === 'customer');
    const productColumns = productHeaderRow
      .map((descriptor, index) => ({ ...parseProductDescriptor(descriptor), index }))
      .filter(({ name, index }) => index >= productStartIndex && name && !normalizeHeader(name).includes('total'));

    return rows.slice(customerHeaderRowIndex + 1).map((row, orderIndex) => {
      const dealer = row[customerColumnIndex]?.trim();
      if (!dealer || normalizeHeader(dealer).includes('total')) return null;

      const order: ParsedOrder = {
        dealer,
        orderNumber: buildOrderNumber('ARR', orderDate, orderIndex),
        plant,
        vehicleNumber: '',
        orderDate,
        items: [],
      };

      productColumns.forEach((productColumn) => {
        const quantity = toQuantity(row[productColumn.index]);
        if (!quantity) return;

        const product = matchProduct(productColumn, lookup);
        order.items.push({
          productId: product?.id,
          srNo: product?.srNo || '',
          name: product?.name || productColumn.name,
          barcode: product?.barcode || '',
          quantity,
          sapCode: productColumn.sapCode,
        });
      });

      return order.items.length > 0 ? order : null;
    }).filter((order): order is ParsedOrder => Boolean(order));
  }

  const headerRowIndex = rows.findIndex((row) => row.some((cell) => normalizeHeader(cell).includes('ordernumber')));
  if (headerRowIndex >= 0) {
    const headers = rows[headerRowIndex].map(normalizeHeader);
    const getCell = (row: CsvRow, names: string[]) => {
      const index = headers.findIndex((header) => names.includes(header));
      return index >= 0 ? row[index]?.trim() : '';
    };

    const groupedOrders = new Map<string, ParsedOrder>();

    rows.slice(headerRowIndex + 1).forEach((row, rowIndex) => {
      const dealer = getCell(row, ['dealer', 'partyname', 'customer', 'customername']) || 'Imported Dealer';
      const orderNumber = getCell(row, ['ordernumber', 'order']) || buildOrderNumber('ARR', orderDate, rowIndex);
      const productName = getCell(row, ['productname', 'itemname', 'name']);
      const quantity = toQuantity(getCell(row, ['quantity', 'qty', 'dealerquantity']));

      if (!productName || !quantity) return;

      if (!groupedOrders.has(orderNumber)) {
        groupedOrders.set(orderNumber, {
          dealer,
          orderNumber,
          plant: getCell(row, ['plant', 'plantname']) || plant,
          vehicleNumber: getCell(row, ['vehiclenumber', 'vehicle']) || '',
          orderDate: getCell(row, ['orderdate', 'date']) || orderDate,
          items: [],
        });
      }

      const parsedProduct = {
        sapCode: getCell(row, ['sapcode', 'productcode']),
        name: productName,
      };
      const product = matchProduct(parsedProduct, lookup);

      groupedOrders.get(orderNumber)?.items.push({
        productId: product?.id,
        srNo: getCell(row, ['srno', 'serialnumber']) || product?.srNo || '',
        name: product?.name || productName,
        barcode: getCell(row, ['barcode']) || product?.barcode || '',
        quantity,
        sapCode: parsedProduct.sapCode,
      });
    });

    return Array.from(groupedOrders.values()).filter((order) => order.items.length > 0);
  }

  return [];
}

// Define a complete order schema that combines the header and items
const createOrderSchema = z.object({
  header: insertOrderSchema,
  items: z.array(insertOrderItemSchema.omit({ orderId: true }))
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
        header.createdByCode = (req.user as any).userCode;
      }

      // Insert the order header
      const [newOrder] = await db.insert(orders).values(header).returning();

      if (!newOrder) {
        return res.status(500).json({ error: 'Failed to create order' });
      }

      // Insert all order items with required fields
      const orderItemsWithOrderId = items.map((item: any) => ({
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
      const orderItemsWithOrderId = items.map((item: any) => ({
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
  apiRouter.post('/orders/import-csv', upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'CSV file is required' });
      }

      const csvText = req.file.buffer.toString('utf-8');
      const rows = parseCsvRows(csvText);
      const productRows = await db.select().from(products);
      const parsedOrders = parseArrivingOrdersCsv(rows, productRows, {
        plant: typeof req.body.plant === 'string' ? req.body.plant : undefined,
        orderDate: typeof req.body.orderDate === 'string' ? req.body.orderDate : undefined,
      });

      if (parsedOrders.length === 0) {
        return res.status(400).json({
          message: 'No arriving orders were found in the CSV. Please check the file format.',
        });
      }

      const importedOrders = [];
      const importedItems = [];
      const userCode = (req.user as { userCode?: string } | undefined)?.userCode;

      for (const parsedOrder of parsedOrders) {
        const [newOrder] = await db.insert(orders).values({
          orderNumber: parsedOrder.orderNumber,
          dealer: parsedOrder.dealer,
          plant: parsedOrder.plant,
          vehicleNumber: parsedOrder.vehicleNumber,
          orderDate: parsedOrder.orderDate,
          status: 'ARRIVING',
          createdByCode: userCode,
          notes: `Imported from ${req.file.originalname}`,
        }).returning();

        if (!newOrder) continue;

        importedOrders.push(newOrder);

        const itemsForOrder = parsedOrder.items.map((item) => ({
          orderId: newOrder.id,
          productId: item.productId,
          srNo: item.srNo || '',
          name: item.name,
          barcode: item.barcode || '',
          quantity: item.quantity,
          unitPrice: '0',
          totalPrice: '0',
          category: '',
          hsn: '',
        }));

        if (itemsForOrder.length > 0) {
          const newItems = await db.insert(orderItems).values(itemsForOrder).returning();
          importedItems.push(...newItems);
        }
      }

      return res.status(201).json({
        success: true,
        ordersCreated: importedOrders.length,
        itemsCreated: importedItems.length,
        orders: importedOrders.slice(0, 20),
      });
    } catch (error) {
      console.error('Error importing CSV:', error);
      return res.status(500).json({ message: 'Failed to import CSV data' });
    }
  });

  apiRouter.post('/import/orders', async (req: Request, res: Response) => {
    try {
      const { items, orderHeader } = req.body;
      
      if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid CSV data format' });
      }

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
