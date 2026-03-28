import { Router } from 'express';
import { storage } from '../storage';
import { Client } from '@notionhq/client';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { plants, insertPlantSchema } from '../../shared/schema';

const router = Router();

// API endpoint to import proforma slips from external API
router.post('/proforma-slips/import-api', async (req, res) => {
  try {
    console.log('📋 Notion Import API called');
    
    // TEMPORARY: Authentication disabled for testing core functionality
    // TODO: Re-enable authentication after fixing session handling
    
    /*
    // Check if user is authenticated and has admin/super-admin role
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Authentication required' 
      });
    }

    const userRole = req.user.role;
    if (userRole !== 'admin' && userRole !== 'super-admin') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Only administrators and super-administrators can import from Notion.' 
      });
    }
    */

    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        message: 'Start date and end date are required' 
      });
    }

    console.log(`API Import request: ${startDate} to ${endDate}`);
    
    const apiKey = process.env.PROFORMA_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ 
        success: false, 
        message: 'API key not configured' 
      });
    }

    console.log(`API Key (first 10 chars): ${apiKey.substring(0, 10)}...`);
    console.log(`Date range: ${startDate} to ${endDate}`);
    
    // Initialize Notion client
    const notion = new Client({
      auth: process.env.NOTION_INTEGRATION_SECRET,
    });
    
    // Extract database ID from the Notion page URL
    const notionPageUrl = process.env.NOTION_PAGE_URL!;
    const databaseIdMatch = notionPageUrl.match(/([a-f0-9]{32})/);
    if (!databaseIdMatch) {
      throw new Error('Invalid Notion page URL - could not extract database ID');
    }
    const databaseId = databaseIdMatch[1];
    console.log(`Fetching data from Notion database: ${databaseId}`);
    
    // First, try to get database schema to understand available properties
    let databaseInfo;
    let notionResponse;
    let orderPlantMap = new Map(); // Declare here so it's accessible later
    
    try {
      databaseInfo = await notion.databases.retrieve({
        database_id: databaseId
      });
      console.log('Available properties:', Object.keys(databaseInfo.properties));
      
      // Query Notion database with pagination to get ALL records
      const allResults = [];
      let hasMore = true;
      let nextCursor = undefined;
      
      // Add date filter to Notion query
      while (hasMore) {
        const response = await notion.databases.query({
          database_id: databaseId,
          page_size: 100,
          start_cursor: nextCursor,
          filter: {
            and: [
              {
                property: 'Ord Date :',
                date: {
                  on_or_after: startDate
                }
              },
              {
                property: 'Ord Date :',
                date: {
                  on_or_before: endDate
                }
              }
            ]
          }
        });
        allResults.push(...response.results);
        hasMore = response.has_more;
        nextCursor = response.next_cursor;
        console.log(`Retrieved batch of ${response.results.length} records (total: ${allResults.length})`);
      }
      notionResponse = { results: allResults };
      console.log(`Retrieved ${allResults.length} total records from Notion (filtered by date)`);

      // Also fetch from the order database to get plant information
      const ORDER_DATABASE_ID = '296851d9af9e4a14966376e58f8475e5';
      console.log(`Fetching order data from Notion database: ${ORDER_DATABASE_ID}`);
      
      const allOrderResults = [];
      let orderHasMore = true;
      let orderNextCursor = undefined;
      
      while (orderHasMore) {
        const orderResponse = await notion.databases.query({
          database_id: ORDER_DATABASE_ID,
          page_size: 100,
          start_cursor: orderNextCursor
        });
        
        allOrderResults.push(...orderResponse.results);
        orderHasMore = orderResponse.has_more;
        orderNextCursor = orderResponse.next_cursor;
        
        console.log(`Retrieved order batch of ${orderResponse.results.length} records (total: ${allOrderResults.length})`);
      }
      
      const orderNotionResponse = { results: allOrderResults };
      console.log(`Retrieved ${allOrderResults.length} total order records from Notion`);

      // Create a lookup map for order numbers to plant values
      orderPlantMap = new Map();
      orderNotionResponse.results.forEach((orderPage: any) => {
        const orderProps = orderPage.properties;
        const orderNumber = orderProps['Order No.']?.title?.[0]?.plain_text || orderProps['Order No.']?.rich_text?.[0]?.plain_text || '';
        const plantValue = orderProps['Plant']?.select?.name || orderProps['Plant ']?.select?.name || '';
        
        if (orderNumber && plantValue) {
          orderPlantMap.set(orderNumber, plantValue);
        }
      });
      
      console.log(`Created plant lookup map with ${orderPlantMap.size} entries`);
      if (orderPlantMap.size > 0) {
        const sampleEntries = Array.from(orderPlantMap.entries()).slice(0, 3);
        console.log('Sample plant mappings:', sampleEntries);
      }
    
    // Debug: Show a sample of the raw data to understand field structure
    if (notionResponse.results.length > 0) {
      const sampleRow = notionResponse.results[0] as any;
      const sampleData: any = {};
      
      for (const [key, value] of Object.entries(sampleRow.properties)) {
        const prop = value as any;
        if (key.includes('Order') || key.includes('Party') || key.includes('Date')) {
          switch (prop.type) {
            case 'title':
            case 'rich_text':
              sampleData[key] = prop[prop.type]?.[0]?.plain_text || '';
              break;
            case 'number':
              sampleData[key] = prop.number;
              break;
            case 'date':
              sampleData[key] = prop.date?.start || null;
              break;
            case 'select':
              sampleData[key] = prop.select?.name || '';
              break;
            case 'formula':
              sampleData[key] = prop.formula?.number || prop.formula?.string || '';
              break;
            default:
              sampleData[key] = JSON.stringify(prop).substring(0, 50);
          }
        }
      }
      
      console.log('Sample key fields from first record:', JSON.stringify(sampleData, null, 2));
      
      // Debug: Show actual extracted values being used - will be processed below

    }
      
    } catch (error: any) {
      console.error('Notion API error:', error);
      if (error.code === 'object_not_found') {
        throw new Error('Database not found. Make sure the integration has access to the database. Go to your Notion page, click "..." → "Connections" → Add your integration.');
      } else if (error.code === 'unauthorized') {
        throw new Error('Unauthorized access. Check if NOTION_INTEGRATION_SECRET is correct and the integration has access to this database.');
      }
      throw new Error(`Notion API error: ${error.message}`);
    }
    
    // Transform Notion response to our expected format
    const rawApiData = notionResponse.results.map((page: any) => {
      const properties = page.properties;
      const row: any = {};
      
      // Extract all properties from the Notion page
      for (const [key, value] of Object.entries(properties)) {
        const prop = value as any;
        
        // Handle different Notion property types
        switch (prop.type) {
          case 'title':
          case 'rich_text':
            row[key] = prop[prop.type]?.[0]?.plain_text || '';
            break;
          case 'number':
            row[key] = prop.number;
            break;
          case 'date':
            row[key] = prop.date?.start || null;
            break;
          case 'select':
            row[key] = prop.select?.name || '';
            break;
          case 'multi_select':
            row[key] = prop.multi_select?.map((s: any) => s.name).join(', ') || '';
            break;
          case 'checkbox':
            row[key] = prop.checkbox;
            break;
          case 'formula':
            // Handle formula properties that might contain text values
            if (prop.formula?.string) {
              row[key] = prop.formula.string;
            } else if (prop.formula?.number !== null && prop.formula?.number !== undefined) {
              row[key] = prop.formula.number;
            } else {
              row[key] = '';
            }
            break;
          case 'rollup':
            // Handle rollup properties that might contain select values
            if (prop.rollup?.array && prop.rollup.array.length > 0) {
              const firstItem = prop.rollup.array[0];
              if (firstItem?.select?.name) {
                row[key] = firstItem.select.name;
              } else if (firstItem?.rich_text?.[0]?.plain_text) {
                row[key] = firstItem.rich_text[0].plain_text;
              } else if (firstItem?.number !== null && firstItem?.number !== undefined) {
                row[key] = firstItem.number;
              } else {
                row[key] = '';
              }
            } else if (prop.rollup?.number !== null && prop.rollup?.number !== undefined) {
              row[key] = prop.rollup.number;
            } else {
              row[key] = '';
            }
            break;
          default:
            row[key] = JSON.stringify(prop);
        }
      }
      
      return row;
    });
    
    // Get all products to match with column names
    const allProducts = await storage.getAllProducts();
    console.log(`Loaded ${allProducts.length} products for matching`);
    
    // Create lookup maps for product matching
    const productBySrNo = new Map();
    const productByItemName = new Map();
    const productBySku = new Map();
    
    for (const product of allProducts) {
      if (product.srNo) productBySrNo.set(product.srNo.toLowerCase(), product);
      if (product.name) productByItemName.set(product.name.toLowerCase(), product);
      if (product.barcode) productBySku.set(product.barcode.toLowerCase(), product);
    }
    
    // Transform the raw API data to our expected format
    // Group by Order No. and process items
    const ordersMap = new Map();
    
    // Helper function to format date to DD/MM/YYYY
    function formatDateToDDMMYYYY(dateString: string): string {
      try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) {
          return dateString; // Return original if invalid
        }
        
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        
        return `${day}/${month}/${year}`;
      } catch (error) {
        console.error('Error formatting date:', error);
        return dateString;
      }
    }
    
    // Track unmatched items for debugging
    const unmatchedItems = new Set();
    
    if (Array.isArray(rawApiData)) {
      for (const row of rawApiData) {
        const orderNo = row['Order No. :'] || row['Order No.'] || row['orderNo'] || `API-${Date.now()}`;
        const rawOrderDate = row['For Ord Date :'] || row['Ord Date :'] || row['orderDate'] || row['Order Date'] || startDate;
        const ordDate = formatDateToDDMMYYYY(rawOrderDate);
        const partyName = row['For Party Name :'] || row['For Party Name '] || row['For Party Name'] || row['Party Name'] || row['partyName'] || 'Unknown Party';
        
        // Get plant value from the order database lookup map
        const plant = orderPlantMap.get(orderNo) || row['Plant :'] || row['Plant'] || row['plant'] || 'VALSAD';
        
        // Debug: Log extracted values for first few orders
        if (ordersMap.size < 3) {
          const plantFields = Object.keys(row).filter(key => key.toLowerCase().includes('plant'));
          console.log(`📋 Order ${orderNo} extracted:`, {
            rawOrderDate: rawOrderDate,
            formattedOrderDate: ordDate,
            availablePlantFields: plantFields,
            plantFieldValues: plantFields.map(field => `${field}: "${row[field]}"`),
            plantFieldType: typeof row['Plant :'],
            rawPlant: row['Plant :'],
            finalPlant: plant,
            partyName: partyName,
            // Debug the exact Notion structure for Plant field
            rawPlantStructure: JSON.stringify(row['Plant :'])
          });
        }
        
        // Create or update order
        if (!ordersMap.has(orderNo)) {
          ordersMap.set(orderNo, {
            orderNumber: orderNo,
            orderDate: ordDate,
            partyName: partyName,
            plant: plant,
            items: new Map() // Use Map to handle duplicate sr_no items
          });
        }
        
        // Process all columns that look like product columns (contain braces or are known product codes)
        for (const [key, value] of Object.entries(row)) {
          if (value && typeof value === 'number' && value > 0) {
            // Extract product identifier from column name
            let srNo = '';
            let productName = '';
            
            // Try to extract srNo from column name patterns
            if (key.includes('{') && key.includes('}')) {
              // Format: "C001 {product description}"
              const match = key.match(/^([A-Z]\d+)/);
              if (match) {
                srNo = match[1];
                productName = key;
              }
            } else if (/^[A-Z]\d+/.test(key)) {
              // Direct product code like "C001"
              srNo = key;
              productName = key;
            }
            
            if (srNo) {
              // Find matching product using sr_no matching (as requested)
              const matchedProduct = productBySrNo.get(srNo.toLowerCase());
              
              if (matchedProduct) {
                const order = ordersMap.get(orderNo);
                
                // Use Map to handle aggregation of duplicate sr_no items
                if (order.items.has(srNo)) {
                  // Add to existing quantity
                  const existingItem = order.items.get(srNo);
                  existingItem.quantity += value;
                  console.log(`🔄 Aggregated ${srNo}: ${existingItem.quantity} (added ${value})`);
                } else {
                  // Create new item
                  order.items.set(srNo, {
                    productId: matchedProduct.id,
                    productSrNo: matchedProduct.srNo,
                    productName: matchedProduct.name,
                    quantity: value
                  });
                }
              } else {
                // Log unmatched items for debugging
                const unmatchedKey = `${srNo} - ${key}`;
                if (!unmatchedItems.has(unmatchedKey)) {
                  console.log(`⚠️  UNMATCHED ITEM: srNo=${srNo}, column=${key}, qty=${value}`);
                  unmatchedItems.add(unmatchedKey);
                }
              }
            }
          }
        }
      }
    }
    
    console.log(`Received ${ordersMap.size} slips from API`);
    
    let slipsCreated = 0;
    let slipsUpdated = 0;
    let itemsCreated = 0;
    let itemsUpdated = 0;
    
    // Create/update proforma slips
    for (const [orderNo, orderData] of ordersMap) {
      try {
        // Check if slip already exists
        const existingSlip = await storage.getProformaSlipByOrderNumber(orderNo);
        
        let slipId;
        if (existingSlip) {
          console.log(`📋 Order ${orderNo} already exists, updating items...`);
          slipId = existingSlip.id;
          slipsUpdated++;
        } else {
          // Create new slip
          const newSlip = await storage.createProformaSlip({
            orderNumber: orderData.orderNumber,
            orderDate: orderData.orderDate,
            partyName: orderData.partyName,
            plant: orderData.plant,
            totalQuantity: 0, // Will be calculated when items are added
            totalVolume: "0.00",
            notes: "Imported from Notion API"
          });
          
          console.log(`✅ Created new slip for order ${orderNo}`);
          slipId = newSlip.id;
          slipsCreated++;
        }
        
        // Clear existing items for this slip and recreate them
        await storage.deleteProformaSlipItems(slipId);
        
        // Add items to the slip
        for (const [srNo, itemData] of orderData.items) {
          await storage.createProformaSlipItem({
            proformaSlipId: slipId,
            productId: itemData.productId,
            quantity: itemData.quantity
          });
          itemsCreated++;
        }
        
      } catch (error) {
        console.error(`Error processing order ${orderNo}:`, error);
      }
    }
    
    // Log unmatched items summary
    if (unmatchedItems.size > 0) {
      console.log(`⚠️  Summary: ${unmatchedItems.size} unmatched item types were skipped`);
    }
    
    return res.status(200).json({
      success: true,
      message: `Successfully imported from Notion API. Created ${slipsCreated} new slips, updated ${slipsUpdated} existing slips, and processed ${itemsCreated} items.`,
      slipsCreated,
      slipsUpdated,
      itemsCreated,
      unmatchedItemsCount: unmatchedItems.size
    });
    
  } catch (error: any) {
    console.error('API Import error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Import failed',
      error: error.toString()
    });
  }
});

// Get all plants
router.get('/plants', async (req: Request, res: Response) => {
  try {
    const allPlants = await storage.getAllPlants();
    return res.json(allPlants);
  } catch (error) {
    console.error('Get plants error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch plants' });
  }
});

// Get plant by name
router.get('/plants/by-name/:name', async (req: Request, res: Response) => {
  try {
    const plantName = String(req.params.name).toUpperCase().trim();
    console.log('🔍 Fetching plant config for:', plantName);
    
    const plant = await storage.getPlantByName(plantName);
    console.log('📦 Plant config found:', plant);
    
    if (!plant) {
      return res.status(404).json({ success: false, message: 'Plant not found' });
    }
    
    return res.json({ success: true, plant });
  } catch (error) {
    console.error('Get plant by name error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch plant' });
  }
});

// Create/Update a Plant (admin/super-admin only)
router.post('/plants', async (req: Request, res: Response) => {
  try {
    const role = String((req as any)?.user?.role ?? '').toLowerCase();
    const allowed = ['admin','superadmin','super admin','super_admin','super-admin'];
    if (!allowed.includes(role)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    console.log('💾 Plant POST payload:', req.body); // DEBUG

    const payload = insertPlantSchema.parse(req.body);
    const upperName = String(payload.name).toUpperCase();

    console.log('🔍 Parsed payload:', payload); // DEBUG

    const existing = await storage.getPlantByName(upperName);

    let saved;
    if (existing) {
      saved = await storage.updatePlant(existing.id, {
        bgColor: payload.bgColor,
        textColor: payload.textColor,
        borderColor: payload.borderColor,
        isLockingEnabled: payload.isLockingEnabled !== undefined ? payload.isLockingEnabled : true,
        isSplitPagesEnabled: payload.isSplitPagesEnabled !== undefined ? payload.isSplitPagesEnabled : false,
      });
      console.log('✅ Plant updated:', saved);
    } else {
      saved = await storage.createPlant({
        name: upperName,
        bgColor: payload.bgColor,
        textColor: payload.textColor,
        borderColor: payload.borderColor,
        isLockingEnabled: payload.isLockingEnabled !== undefined ? payload.isLockingEnabled : true,
        isSplitPagesEnabled: payload.isSplitPagesEnabled !== undefined ? payload.isSplitPagesEnabled : false,
      });
      console.log('✅ Plant created:', saved);
    }

    return res.json({ success: true, plant: saved });
  } catch (error: any) {
    console.error('❌ Create plant error:', error);
    return res.status(400).json({ success: false, message: error?.message || 'Invalid payload' });
  }
});

// Update existing plant
router.put('/plants/:id', async (req: Request, res: Response) => {
  try {
    const role = String((req as any)?.user?.role ?? '').toLowerCase();
    const allowed = ['admin','superadmin','super admin','super_admin','super-admin'];
    if (!allowed.includes(role)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const id = parseInt(req.params.id);
    console.log('💾 Plant PUT payload:', req.body); // DEBUG

    const payload = insertPlantSchema.parse(req.body);
    console.log('🔍 Parsed PUT payload:', payload); // DEBUG

    const updated = await storage.updatePlant(id, {
      name: String(payload.name).toUpperCase(),
      bgColor: payload.bgColor,
      textColor: payload.textColor,
      borderColor: payload.borderColor,
      isLockingEnabled: payload.isLockingEnabled !== undefined ? payload.isLockingEnabled : true,
      isSplitPagesEnabled: payload.isSplitPagesEnabled !== undefined ? payload.isSplitPagesEnabled : false,
    });

    console.log('✅ Plant updated via PUT:', updated);
    return res.json({ success: true, plant: updated });
  } catch (error: any) {
    console.error('❌ Update plant error:', error);
    return res.status(400).json({ success: false, message: error?.message || 'Invalid payload' });
  }
});

// Delete plant
router.delete('/plants/:id', async (req: Request, res: Response) => {
  try {
    const role = String((req as any)?.user?.role ?? '').toLowerCase();
    const allowed = ['admin','superadmin','super admin','super_admin','super-admin'];
    if (!allowed.includes(role)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const id = parseInt(req.params.id);
    await storage.deletePlant(id);
    return res.json({ success: true });
  } catch (error) {
    console.error('Delete plant error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete plant' });
  }
});

// Lock a proforma slip after print - CHECK IF PLANT ALLOWS LOCKING
router.post('/proforma-slips/order/:orderNumber/lock', async (req: Request, res: Response) => {
  try {
    const orderNumber = String(req.params.orderNumber).trim();
    const slip = await storage.getProformaSlipByOrderNumber(orderNumber);
    if (!slip) return res.status(404).json({ success: false, message: 'Proforma slip not found' });

    // NEW: Check if plant has locking enabled
    const plantName = String(slip.plant || '').toUpperCase();
    const plantConfig = await storage.getPlantByName(plantName);
    const isLockingEnabled = plantConfig?.isLockingEnabled ?? true; // default true if plant not configured

    if (!isLockingEnabled) {
      console.log(`Plant ${plantName} has locking disabled - skipping lock`);
      return res.json({ success: true, slip, skipped: true, message: 'Locking disabled for this plant' });
    }

    const sessionUser = (req as any).user || (req as any).session?.user;
    const printedByCode = req.body?.printedByCode ?? sessionUser?.userCode ?? null;
    
    const updated = await storage.updateProformaSlip(slip.id, {
      isPrintLocked: true,
      printedByCode,
      printedAt: new Date(),
      printCount: (slip.printCount ?? 0) + 1,
    });

    try {
      await storage.createActivity({
        pageName: 'ProformaSlips',
        action: 'lock',
        entityType: 'proformaSlip',
        entityId: String(slip.id),
        details: `Order ${slip.orderNumber} locked for printing`,
        userCode: printedByCode || undefined,
        userName: sessionUser?.name || sessionUser?.username || undefined,
      });
    } catch {}

    return res.json({ success: true, slip: updated });
  } catch (error) {
    console.error('Lock slip error:', error);
    return res.status(500).json({ success: false, message: 'Failed to lock slip' });
  }
});

// Unlock a proforma slip (admin/super-admin OR Head-Billing)
router.post('/proforma-slips/order/:orderNumber/unlock', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user || (req as any).session?.user;
    if (!user) {
      return res.status(403).json({ success: false, message: 'Not authenticated' });
    }

    const role = String(user.role || '').toLowerCase();
    const dept = String(user.department || '').toLowerCase();
    const desig = String(user.designation || '').toLowerCase();

    const isAdminOrSuper = ['admin', 'superadmin', 'super admin', 'super-admin'].includes(role);
    // User requested "department is billing and designation is head"
    const isHeadBilling = dept === 'billing' && desig === 'head';
    const isITDep= ['IT', 'information technology', 'it'].includes(dept);
    const ismanagment = ['management', 'manager', 'head', 'director'].includes(dept);

    console.log(`🔐 Unlock request by ${user.name || user.username} (Role: ${role}, Dept: ${dept}, Desig: ${desig}) - Admin/Super: ${isAdminOrSuper}, Head-Billing: ${isHeadBilling}, IT: ${isITDep}, Management: ${ismanagment}`)  ;
    if (!isAdminOrSuper && !isHeadBilling && !isITDep && !ismanagment) {
      return res.status(403).json({ success: false, message: 'Access denied: Requires Admin or Billing-Head or IT or Management' });
    }

    const orderNumber = String(req.params.orderNumber).trim();
    const slip = await storage.getProformaSlipByOrderNumber(orderNumber);
    if (!slip) return res.status(404).json({ success: false, message: 'Proforma slip not found' });

    const updated = await storage.updateProformaSlip(slip.id, { isPrintLocked: false });

    // Activity log (optional)
    try {
      await storage.createActivity({
        pageName: 'ProformaSlips',
        action: 'unlock',
        entityType: 'proformaSlip',
        entityId: String(slip.id),
        details: `Order ${slip.orderNumber} unlocked by ${user?.name || user?.username}`,
        userCode: user?.userCode,
        userName: user?.name || user?.username,
      });
    } catch {}

    return res.json({ success: true, slip: updated });
  } catch (error) {
    console.error('Unlock slip error:', error);
    return res.status(500).json({ success: false, message: 'Failed to unlock slip' });
  }
});

export default router;
