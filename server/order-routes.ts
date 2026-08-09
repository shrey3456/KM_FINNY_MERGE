import { Router, Request, Response } from 'express';
import { db } from './db';
import {
  orders,
  orderItems,
  products,
  insertOrderSchema,
  insertOrderItemSchema,
  proformaSlips,
  proformaSlipItems
} from '@shared/schema';
import { asc, eq, desc, ilike, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { requirePageWrite } from './lib/pageAccess';

// Keep uploads in memory for small CSVs, but enforce a conservative file size limit
// so production instances don't OOM when someone accidentally uploads a very large file.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

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

function mergeWrappedHeaderRows(rows: CsvRow[]) {
  const merged: CsvRow[] = [];

  rows.forEach((row) => {
    if (merged.length === 0) {
      merged.push([...row]);
      return;
    }

    const previous = merged[merged.length - 1];
    const previousHasHeader = previous.some((cell) => {
      const normalized = normalizeHeader(cell || '');
      return normalized.includes('customer') ||
        normalized.includes('productcode') ||
        normalized.includes('productname') ||
        normalized === 'state';
    });

    const startsWithEmpty = !row[0] || normalizeHeader(row[0]) === '';
    if (previousHasHeader && startsWithEmpty) {
      const toAppend = row.slice(1);
      if (toAppend.some((cell) => cell !== '')) {
        previous.push(...toAppend);
        return;
      }
    }

    merged.push([...row]);
  });

  return merged;
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
  const byBarcode = new Map<string, typeof products.$inferSelect>();

  productRows.forEach((product) => {
    if (product.sapCode) bySap.set(product.sapCode.trim(), product);
    byName.set(product.name.trim().toLowerCase(), product);
    if (product.barcode) byBarcode.set(product.barcode.trim().toLowerCase(), product);
  });

  return { bySap, byName, byBarcode };
}

function matchProduct(
  item: { sapCode?: string; name: string; barcode?: string },
  lookup: ReturnType<typeof buildProductLookup>,
) {
  // Try barcode first (most precise match)
  if (item.barcode) {
    const byBarcode = lookup.byBarcode.get(item.barcode.trim().toLowerCase());
    if (byBarcode) return byBarcode;
  }
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
  const normalizedRows = mergeWrappedHeaderRows(rows);
  const lookup = buildProductLookup(productRows);
  const plant = options.plant?.trim() || 'Valsad';
  const orderDate = options.orderDate || new Date().toISOString().split('T')[0];

  if (normalizedRows.length < 2) return [];

  const productHeaderRowIndex = normalizedRows.findIndex((row) =>
    row.some((cell) => normalizeHeader(cell).includes('productcode')),
  );
  const customerHeaderRowIndex = normalizedRows.findIndex((row) =>
    row.some((cell) => normalizeHeader(cell).includes('customer') || normalizeHeader(cell) === 'customer'),
  );

  if (productHeaderRowIndex >= 0 && customerHeaderRowIndex >= 0) {
    if (customerHeaderRowIndex < productHeaderRowIndex) {
      // Columns are customers, rows are products
      const customerRow = normalizedRows[customerHeaderRowIndex].map((cell) => cell.trim());
      const productHeaderRow = normalizedRows[productHeaderRowIndex].map((cell) => cell.trim());

      const customerLabelIndex = customerRow.findIndex(
        (cell) => normalizeHeader(cell) === 'customer',
      );
      const productNameIndex = productHeaderRow.findIndex((cell) => {
        const normalized = normalizeHeader(cell);
        return normalized.includes('productcode') || normalized.includes('productname');
      });

      const dealerStartIndex = (customerLabelIndex >= 0 ? customerLabelIndex : productNameIndex) + 1;

      const dealerColumns = customerRow
        .map((dealer, index) => ({ dealer, index }))
        .filter(({ dealer, index }) => {
          const normalized = normalizeHeader(dealer);
          return index >= dealerStartIndex &&
            dealer &&
            !normalized.includes('total') &&
            normalized !== 'state';
        });

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

      // Products start after productHeaderRowIndex
      normalizedRows.slice(productHeaderRowIndex + 1).forEach((row) => {
        const descriptor = row[productNameIndex >= 0 ? productNameIndex : 0];
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

      const parsedOrders = Array.from(ordersByDealer.values()).filter((order) => order.items.length > 0);
      if (parsedOrders.length > 0) return parsedOrders;
    } else {
      // Columns are products, rows are customers
      const productHeaderRow = normalizedRows[productHeaderRowIndex];
      const customerHeaderRow = normalizedRows[customerHeaderRowIndex];
      const productStartIndex = productHeaderRow.findIndex((cell) => normalizeHeader(cell).includes('productcode')) + 1;
      const customerColumnIndex = customerHeaderRow.findIndex((cell) => normalizeHeader(cell) === 'customer');
      const productColumns = productHeaderRow
        .map((descriptor, index) => ({ ...parseProductDescriptor(descriptor), index }))
        .filter(({ name, index }) => index >= productStartIndex && name && !normalizeHeader(name).includes('total'));

      const parsedOrders = normalizedRows.slice(customerHeaderRowIndex + 1).map((row, orderIndex) => {
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
      
      if (parsedOrders.length > 0) return parsedOrders;
    }
  }

  const headerRowIndex = normalizedRows.findIndex((row) => row.some((cell) => normalizeHeader(cell).includes('ordernumber')));
  if (headerRowIndex >= 0) {
    const headers = normalizedRows[headerRowIndex].map(normalizeHeader);
    const getCell = (row: CsvRow, names: string[]) => {
      const index = headers.findIndex((header) => names.includes(header));
      return index >= 0 ? row[index]?.trim() : '';
    };

    const groupedOrders = new Map<string, ParsedOrder>();

    normalizedRows.slice(headerRowIndex + 1).forEach((row, rowIndex) => {
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

      // Read barcode from 'productBarcode' or 'barcode' column — normalised to lowercase without spaces
      const barcodeFromCsv = getCell(row, ['productbarcode', 'barcode']);
      const parsedProduct = {
        sapCode: getCell(row, ['sapcode', 'productcode']),
        name: productName,
        barcode: barcodeFromCsv,
      };
      const product = matchProduct(parsedProduct, lookup);

      groupedOrders.get(orderNumber)?.items.push({
        productId: product?.id,
        srNo: getCell(row, ['productsrno', 'srno', 'serialnumber']) || product?.srNo || '',
        name: product?.name || productName,
        // Always prefer the barcode from the CSV column over the inventory fallback
        barcode: barcodeFromCsv || product?.barcode || '',
        quantity,
        sapCode: parsedProduct.sapCode,
      });
    });

    return Array.from(groupedOrders.values()).filter((order) => order.items.length > 0);
  }

  // Fallback: accept very simple CSVs where each row is [product, quantity, dealer?]
  // Many users will upload a minimal file with two columns: product name/code and qty.
  // We'll treat each non-empty row as one order per dealer (or a single dealer if provided in the 3rd column).
  const fallbackParsed: ParsedOrder[] = [];
  normalizedRows.forEach((row, rowIndex) => {
    const prod = (row[0] || '').trim();
    const qty = toQuantity(row[1]);
    if (!prod || !qty) return;

    const dealer = (row[2] || 'Imported Dealer').trim() || 'Imported Dealer';
    const orderKey = `${dealer}-${rowIndex}`;

    let order = fallbackParsed.find((o) => o.orderNumber === orderKey);
    if (!order) {
      order = {
        dealer,
        orderNumber: buildOrderNumber('ARR', orderDate, fallbackParsed.length),
        plant,
        vehicleNumber: '',
        orderDate,
        items: [],
      };
      fallbackParsed.push(order);
    }

    const parsedProduct = parseProductDescriptor(prod);
    const product = matchProduct(parsedProduct, lookup);
    order.items.push({
      productId: product?.id,
      srNo: product?.srNo || '',
      name: product?.name || parsedProduct.name,
      barcode: product?.barcode || '',
      quantity: qty,
      sapCode: parsedProduct.sapCode,
    });
  });

  return fallbackParsed.filter((o) => o.items.length > 0);
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
      // Simple pagination to avoid returning massive result sets in production.
      const limitParam = typeof _req.query.limit === 'string' ? parseInt(_req.query.limit, 10) : NaN;
      const pageParam = typeof _req.query.page === 'string' ? parseInt(_req.query.page, 10) : NaN;
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 100;
      const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
      const offset = (page - 1) * limit;

      const result = await db.select().from(orders).orderBy(desc(orders.createdAt)).limit(limit).offset(offset);
      return res.json({ page, limit, results: result });
    } catch (error) {
      console.error('Error fetching orders:', error);
      return res.status(500).json({ error: 'Failed to fetch orders' });
    }
  });

  // List imported arriving order CSVs (paginated)
  apiRouter.get('/orders/imports', async (req: Request, res: Response) => {
    try {
      const pageParam = typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : NaN;
      const limitParam = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
      // Pagination UI was removed client-side — OrderManagement.tsx now requests everything in
      // one page. Cap raised well above any realistic count purely as a safety ceiling.
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 5000) : 10;

      // Fetch ALL import-tagged orders (no row-level limit) — only 2 tiny columns,
      // safe even with thousands of orders. Deduplicate by noteKey in JS so we
      // return one entry per uploaded batch regardless of how many dealer rows it produced.
      const allImportedOrders = await db
        .select({ notes: orders.notes, createdAt: orders.createdAt })
        .from(orders)
        .where(ilike(orders.notes, '%Imported from%'))
        .orderBy(desc(orders.createdAt));

      const importsMap = new Map<string, { filename: string; noteKey: string; orderCount: number; itemCount: number; lastImportedAt: string }>();

      for (const order of allImportedOrders) {
        const note = order.notes || '';

        // New format: "Imported from filename.csv#1234567890"
        // Legacy format: "Imported from filename.csv" or "Imported from Excel file: filename.xlsx"
        let filename: string;
        let noteKey: string;

        const excelMatch = note.match(/Imported from Excel file:\s*(.+?)(?:#\d+)?$/i);
        if (excelMatch) {
          filename = excelMatch[1].trim();
          noteKey = note;
        } else {
          // Strip the "Imported from " prefix and any trailing #timestamp
          const withoutPrefix = note.replace(/^Imported from\s*/i, '').trim();
          const hashIdx = withoutPrefix.lastIndexOf('#');
          filename = hashIdx > 0 ? withoutPrefix.substring(0, hashIdx).trim() : withoutPrefix;
          noteKey = note;
        }

        if (!filename) continue;

        const existing = importsMap.get(noteKey);
        if (existing) {
          existing.orderCount += 1;
        } else {
          importsMap.set(noteKey, {
            filename,
            noteKey,
            orderCount: 1,
            itemCount: 0,
            lastImportedAt: order.createdAt ? new Date(order.createdAt).toISOString() : new Date().toISOString(),
          });
        }
      }

      const allImports = Array.from(importsMap.values());
      const total = allImports.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const safePage = Math.min(page, totalPages);
      const offset = (safePage - 1) * limit;
      const results = allImports.slice(offset, offset + limit);

      return res.json({ results, total, page: safePage, limit, totalPages });
    } catch (error) {
      console.error('Error fetching import list:', error);
      return res.status(500).json({ error: 'Failed to fetch import list' });
    }
  });

  // Fetch aggregated items for a specific imported CSV
  apiRouter.get('/orders/imports/items', async (req: Request, res: Response) => {
    try {
      const filename = typeof req.query.filename === 'string' ? req.query.filename.trim() : '';
      if (!filename) {
        return res.status(400).json({ error: 'filename is required' });
      }

      // If the caller passes a full noteKey (starts with "Imported from"), match exactly.
      // Otherwise treat it as a plain filename substring search (legacy / manual calls).
      const isNoteKey = /^Imported from /i.test(filename);
      const matchingOrders = await db
        .select({ id: orders.id })
        .from(orders)
        .where(isNoteKey ? eq(orders.notes, filename) : ilike(orders.notes, `%${filename}%`));

      const orderIds = matchingOrders.map((order) => order.id);
      if (!orderIds.length) {
        return res.json({ filename, items: [] });
      }

      const items = await db
        .select({
          name: orderItems.name,
          barcode: orderItems.barcode,
          srNo: orderItems.srNo,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, orderIds));

      const aggregate = new Map<string, {
        id: string;
        sku: string;
        itemName: string;
        expectedQty: number;
        scannedQty: number;
        productId?: number;
        barcode?: string;
        itemNo?: string | null;
        sapCode?: string | null;
      }>();

      items.forEach((item, index) => {
        const sku = item.barcode || item.srNo || item.name || `item-${index}`;
        const key = `${sku.toLowerCase()}-${index}`;

        const existing = aggregate.get(key);
        if (existing) {
          existing.expectedQty += item.quantity || 0;
          return;
        }

        aggregate.set(key, {
          id: key,
          sku,
          itemName: item.name,
          expectedQty: item.quantity || 0,
          scannedQty: 0,
          productId: undefined,
          barcode: item.barcode || undefined,
          itemNo: item.srNo || undefined,
          sapCode: undefined,
        });
      });

      // Return a clean display filename (strip the "Imported from " prefix and #timestamp suffix)
      const withoutPrefix = filename.replace(/^Imported from\s*/i, '').trim();
      const hashIdx = withoutPrefix.lastIndexOf('#');
      const displayFilename = hashIdx > 0 ? withoutPrefix.substring(0, hashIdx).trim() : withoutPrefix;

      return res.json({ filename: displayFilename, items: Array.from(aggregate.values()) });
    } catch (error) {
      console.error('Error fetching import items:', error);
      return res.status(500).json({ error: 'Failed to fetch import items' });
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
  apiRouter.post('/orders', requirePageWrite('order-management'), async (req: Request, res: Response) => {
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
  apiRouter.patch('/orders/:id', requirePageWrite('order-management'), async (req: Request, res: Response) => {
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
  apiRouter.delete('/orders/:id', requirePageWrite('order-management'), async (req: Request, res: Response) => {
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

  // Bulk delete orders by CSV noteKey (precise) or filename (all batches for that name)
  apiRouter.post('/orders/batch-delete-by-filename', requirePageWrite('order-management'), async (req: Request, res: Response) => {
    try {
      let { filename, noteKey } = req.body;

      if (!filename && !noteKey) {
        return res.status(400).json({ error: 'filename or noteKey is required' });
      }

      // Use noteKey for precise per-batch delete; fall back to filename wildcard for legacy rows
      const key = typeof noteKey === 'string' ? noteKey.trim() : (filename as string).trim();
      const useExact = typeof noteKey === 'string' && noteKey.trim().length > 0;

      const deletedOrders = await db
        .delete(orders)
        .where(useExact ? eq(orders.notes, key) : ilike(orders.notes, `%${key}%`))
        .returning();

      return res.json({ 
        success: true, 
        deletedCount: deletedOrders.length,
        message: `Successfully deleted ${deletedOrders.length} orders imported from ${filename}`
      });
    } catch (error) {
      console.error('Error deleting batch orders:', error);
      return res.status(500).json({ error: 'Failed to delete orders matching filename' });
    }
  });

  // Convert an order to a proforma slip
  apiRouter.post('/orders/:id/to-proforma', requirePageWrite('order-management'), async (req: Request, res: Response) => {
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
          createdByCode: (req.user as any)?.userCode || orderData.createdByCode
        }).returning();      if (!newProformaSlip) {
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

  // CSV / Excel Import endpoint
  apiRouter.post('/orders/import-csv', requirePageWrite('order-management'), upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'A CSV or Excel file is required' });
      }

      const originalName = req.file.originalname.toLowerCase();
      const isExcel = originalName.endsWith('.xlsx') || originalName.endsWith('.xls');

      let rows: CsvRow[];
      if (isExcel) {
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) {
          return res.status(400).json({ message: 'The Excel file has no sheets.' });
        }
        const sheet = workbook.Sheets[firstSheetName];
        // raw: false formats numbers/dates as display strings instead of raw values
        const rawRows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: '', raw: false });
        rows = (rawRows as any[][])
          .map((r) => r.map((cell) => String(cell ?? '').trim()))
          .filter((r) => r.some((cell) => cell !== ''));
      } else {
        const csvText = req.file.buffer.toString('utf-8');
        rows = parseCsvRows(csvText);
      }
      const normalizedRowsForDebug = mergeWrappedHeaderRows(rows);
      const debugHeaderRowIndex = normalizedRowsForDebug.findIndex((row) =>
        row.some((cell) => normalizeHeader(cell).includes('ordernumber')),
      );
      const debugProductHeaderIndex = normalizedRowsForDebug.findIndex((row) =>
        row.some((cell) => normalizeHeader(cell).includes('productcode')),
      );
      const debugCustomerHeaderIndex = normalizedRowsForDebug.findIndex((row) =>
        row.some((cell) => normalizeHeader(cell).includes('customer') || normalizeHeader(cell) === 'customer'),
      );
      const productRows = await db.select().from(products);
      const parsedOrders = parseArrivingOrdersCsv(rows, productRows, {
        plant: typeof req.body.plant === 'string' ? req.body.plant : undefined,
        orderDate: typeof req.body.orderDate === 'string' ? req.body.orderDate : undefined,
      });

      if (parsedOrders.length === 0) {
        console.error('[import] No orders parsed. File:', req.file.originalname, 'Rows:', rows.length, 'First 5 rows:', JSON.stringify(normalizedRowsForDebug.slice(0, 5)));
        return res.status(400).json({
          message: 'No arriving orders were found in the file. Please check the file format — expected columns: Customer/ProductCode or OrderNumber.',
          debug: {
            file: req.file.originalname,
            rowCount: rows.length,
            normalizedRowCount: normalizedRowsForDebug.length,
            headerRowIndex: debugHeaderRowIndex,
            productHeaderRowIndex: debugProductHeaderIndex,
            customerHeaderRowIndex: debugCustomerHeaderIndex,
            firstRows: normalizedRowsForDebug.slice(0, 5),
          },
        });
      }

      const importedOrders = [];
      const importedItems = [];
      const userCode = (req.user as { userCode?: string } | undefined)?.userCode;
      // Unique batch key so each upload is a distinct entry even if the filename is reused
      const batchKey = `Imported from ${req.file.originalname}#${Date.now()}`;

      for (const parsedOrder of parsedOrders) {
        const [newOrder] = await db.insert(orders).values({
          orderNumber: parsedOrder.orderNumber,
          dealer: parsedOrder.dealer,
          plant: parsedOrder.plant,
          vehicleNumber: parsedOrder.vehicleNumber,
          orderDate: parsedOrder.orderDate,
          status: 'ARRIVING',
          createdByCode: userCode,
          notes: batchKey,
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

  apiRouter.post('/import/orders', requirePageWrite('order-management'), async (req: Request, res: Response) => {
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
