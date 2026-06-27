import { Router } from 'express';
import { storage } from '../storage';
import { Client } from '@notionhq/client';

const router = Router();

// FAST: Optimized Notion import with limited batch processing
router.post('/fast-notion-import', async (req, res) => {
  try {
    console.log('⚡ FAST Notion Import started');
    
    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        message: 'Start date and end date are required' 
      });
    }

    console.log(`⚡ Date range: ${startDate} to ${endDate}`);
    
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
    console.log(`⚡ Database: ${databaseId}`);
    
    // PERFORMANCE: Load products once at the start
    const allProducts = await storage.getAllProducts();
    console.log(`⚡ Loaded ${allProducts.length} products for matching`);
    
    // Create product lookup maps
    const productBySrNo = new Map();
    for (const product of allProducts) {
      if (product.newSr) productBySrNo.set(product.newSr.toLowerCase(), product);
    }

    try {
      // STEP 1: Fetch order database for plant values (FAST - limited batches)
      const ORDER_DATABASE_ID = process.env.ORDER_DATABASE_ID;
      if(!ORDER_DATABASE_ID) {
        return res.status(500).json({ success: false, message: 'ORDER_DATABASE_ID environment variable is not set' });
      }
      console.log(`⚡ Loading plant data...`);
      
      const orderPlantMap = new Map();
      let orderBatchCount = 0;
      let orderNextCursor = undefined;
      const MAX_ORDER_BATCHES = 5; // Small limit for speed
      
      while (orderBatchCount < MAX_ORDER_BATCHES) {
        const orderResponse = await notion.databases.query({
          database_id: ORDER_DATABASE_ID,
          page_size: 100,
          start_cursor: orderNextCursor
        });
        
        // Process plant mappings immediately
        orderResponse.results.forEach((orderPage: any) => {
          const orderProps = orderPage.properties;
          const orderNumber = orderProps['Order No.']?.title?.[0]?.plain_text || 
                             orderProps['Order No.']?.rich_text?.[0]?.plain_text || '';
          const plantValue = orderProps['Plant']?.select?.name || 
                           orderProps['Plant ']?.select?.name || '';
          
          if (orderNumber && plantValue) {
            orderPlantMap.set(orderNumber, plantValue);
          }
        });
        
        orderBatchCount++;
        console.log(`⚡ Plant batch ${orderBatchCount}: +${orderResponse.results.length} (map: ${orderPlantMap.size})`);
        
        if (!orderResponse.has_more) break;
        orderNextCursor = orderResponse.next_cursor;
      }
      
      console.log(`⚡ Plant lookup ready with ${orderPlantMap.size} mappings`);

      // STEP 2: Fetch main database records (FAST - limited batches)
      console.log(`⚡ Loading order data...`);
      
      const ordersMap = new Map();
      let batchCount = 0;
      let nextCursor = undefined;
      const MAX_BATCHES = 8; // Small limit for speed
      
      while (batchCount < MAX_BATCHES) {
        const response = await notion.databases.query({
          database_id: databaseId,
          page_size: 100,
          start_cursor: nextCursor
        });
        
        console.log(`⚡ Processing batch ${batchCount + 1}/${MAX_BATCHES}: ${response.results.length} records`);
        
        // Process records immediately (don't store in memory)
        for (const page of response.results) {
          if (!('properties' in page)) continue;
          const properties = page.properties;
          const row: any = {};
          
          // Extract key properties only
          for (const [key, value] of Object.entries(properties)) {
            const prop = value as any;
            
            switch (prop.type) {
              case 'title':
              case 'rich_text':
                row[key] = prop[prop.type]?.[0]?.plain_text || '';
                break;
              case 'number':
                if (prop.number > 0) row[key] = prop.number;
                break;
              case 'date':
                row[key] = prop.date?.start || null;
                break;
              case 'select':
                row[key] = prop.select?.name || '';
                break;
              case 'formula':
                if (prop.formula?.number > 0) row[key] = prop.formula.number;
                break;
            }
          }
          
          // Extract order info
          const orderNo = row['For Order No. :'] || row['Order No. :'] || row['Order No.'] || '';
          if (!orderNo) continue;
          
          // Ensure rawOrderDate is a string (convert null/undefined to startDate)
          const rawOrderDate = (row['For Ord Date :'] ?? row['Ord Date :'] ?? startDate) as string;
          const ordDate = formatDateToDDMMYYYY(rawOrderDate);
          const partyName = row['For Party Name '] || row['For Party Name'] || 'Unknown Party';
          const plant = orderPlantMap.get(orderNo) || 'VALSAD';
          
          // Create or update order
          if (!ordersMap.has(orderNo)) {
            ordersMap.set(orderNo, {
              orderNumber: orderNo,
              orderDate: ordDate,
              partyName: partyName,
              plant: plant,
              items: new Map()
            });
          }
          
          const order = ordersMap.get(orderNo);
          
          // Process product columns quickly
          for (const [key, value] of Object.entries(row)) {
            if (value && typeof value === 'number' && value > 0) {
              let srNo = '';
              if (/^[A-Z]\d+/.test(key)) {
                srNo = key.split(' ')[0] || key.split('{')[0] || key;
              }
              
              if (srNo) {
                const matchedProduct = productBySrNo.get(srNo.toLowerCase());
                if (matchedProduct) {
                  if (order.items.has(srNo)) {
                    order.items.get(srNo).quantity += value;
                  } else {
                    order.items.set(srNo, {
                      productId: matchedProduct.id,
                      productSrNo: matchedProduct.srNo,
                      productName: matchedProduct.name,
                      quantity: value
                    });
                  }
                }
              }
            }
          }
        }
        
        batchCount++;
        if (!response.has_more) break;
        nextCursor = response.next_cursor;
      }
      
      console.log(`⚡ Processed ${ordersMap.size} orders from ${batchCount} batches`);

      // STEP 3: Create database entries (FAST - batch operations)
      let slipsCreated = 0;
      let itemsCreated = 0;
      
      for (const [orderNo, orderData] of Array.from(ordersMap.entries())) {
        try {
          // Check if slip already exists
          const existingSlip = await storage.getProformaSlipByOrderNumber(orderNo);
          
          let slipId;
          if (existingSlip) {
            slipId = existingSlip.id;
            // Clear existing items - using individual delete calls
            const existingItems = await storage.getProformaSlipItems(slipId);
            for (const item of existingItems) {
              await storage.deleteProformaSlipItem(item.id);
            }
          } else {
            const newSlip = await storage.createProformaSlip({
              orderNumber: orderData.orderNumber,
              orderDate: orderData.orderDate,
              partyName: orderData.partyName,
              plant: orderData.plant,
              totalQuantity: 0,
              totalVolume: "0.00",
              notes: "Fast Import from Notion"
            });
            slipId = newSlip.id;
            slipsCreated++;
          }
          
          // Add items with COMPLETE SNAPSHOT to ensure immutability
          for (const [srNo, itemData] of Array.from(orderData.items.entries())) {
            // Fetch full product details to create snapshot
            const product = await storage.getProduct(itemData.productId);
            if (product) {
              await storage.createProformaSlipItem({
                proformaSlipId: slipId,
                productId: product.id, // Keep for reference only
                quantity: itemData.quantity,
                // Snapshot fields: Store complete product data at import time
                srNo: product.newSr || '',
                itemNo: product.itemNo || '',
                barcode: product.barcode || '',
                itemName: product.name || '',
                category: product.category || '',
                volumeInCuFt: product.volumeInCuFt || '',
                hsnCode: product.hsnCode || '',
                sapCode: product.sapCode || '',
                description: product.description || '',
                purchasePrice: product.purchasePrice || '',
                sellingPrice: product.sellingPrice || '',
              });
              itemsCreated++;
            }
          }
          
        } catch (error) {
          console.error(`Error processing order ${orderNo}:`, error);
        }
      }
      
      return res.status(200).json({
        success: true,
        message: `⚡ Fast import complete! Created ${slipsCreated} slips with ${itemsCreated} items (processed ${batchCount} batches)`,
        slipsCreated,
        itemsCreated,
        batchesProcessed: batchCount
      });
      
    } catch (error: any) {
      console.error('Notion API error:', error);
      throw new Error(`Notion API error: ${error.message}`);
    }
    
  } catch (error: any) {
    console.error('Fast import error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Fast import failed',
      error: error.toString()
    });
  }
});

// Helper function to format date to DD/MM/YYYY
function formatDateToDDMMYYYY(dateString: string): string {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return dateString;
    }
    
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    
    return `${day}/${month}/${year}`;
  } catch (error) {
    return dateString;
  }
}

export default router;