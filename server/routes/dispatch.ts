import { Router } from 'express';
import { Client } from '@notionhq/client';

const router = Router();

// Direct fetch from Notion for dispatch
router.post('/dispatch', async (req, res) => {
  try {
    console.log('📋 Dispatch - Direct Notion fetch');
    
    const { orderNumber } = req.body;
    
    if (!orderNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'Order number is required' 
      });
    }

    console.log(`📋 Fetching dispatch data for order: ${orderNumber}`);
    
    // Initialize Notion client
    const notion = new Client({
      auth: process.env.NOTION_INTEGRATION_SECRET,
    });
    
    // Use ONLY the dispatch database as specified
    const DATABASE_ID = process.env.DISPATCH_DATABASE_ID;
    
    if(!DATABASE_ID) {
      return res.status(500).json({ success: false, message: 'DISPATCH_DATABASE_ID environment variable is not set' });
    }
    
    try {
      console.log(`📋 Searching for order ${orderNumber} in dispatch database: ${DATABASE_ID}`);
      
      // Fast, targeted search with exact match filtering
      console.log(`📋 Performing fast filtered search for order ${orderNumber}`);
      
      let allResults: any[] = [];
      
      // Since "Link to Order No. :" is a formula field, we can't filter by it directly
      // Let's get a small batch and filter manually for speed
      console.log(`📋 Fetching small batch to search manually for order ${orderNumber}`);
      
      const response = await notion.databases.query({
        database_id: DATABASE_ID,
        page_size: 50
      });
      
      allResults = response.results;
      console.log(`📋 Retrieved ${allResults.length} records for manual filtering`);
      
      // Filter results manually to find the matching order
      const matchingResults = allResults.filter((page: any) => {
        if (!('properties' in page)) return false;
        const properties = page.properties;
        
        // Check all possible order number fields
        const linkOrderNo = properties['Link to Order No. :']?.formula?.string || 
                           properties['Link to Order No. :']?.rich_text?.[0]?.plain_text || '';
        const orderNo = properties['Order No.']?.rich_text?.[0]?.plain_text || 
                       properties['Order No.']?.title?.[0]?.plain_text || '';
        
        return linkOrderNo.includes(orderNumber) || orderNo.includes(orderNumber);
      });
      
      console.log(`📋 Found ${matchingResults.length} matching records for order ${orderNumber}`);
      
      if (matchingResults.length === 0) {
        return res.status(404).json({
          success: false,
          message: `Order ${orderNumber} not found in Notion database`
        });
      }
      
      // Since we're already using the dispatch database, get plant data from the same results
      let plantValue = 'VALSAD'; // Default
      if (matchingResults.length > 0) {
        const firstResult = matchingResults[0] as any;
        const orderProps = firstResult.properties;
        plantValue = orderProps['Plant']?.select?.name || 
                    orderProps['Plant ']?.select?.name || 
                    'VALSAD';
      }
      
      console.log(`📋 Plant for order ${orderNumber}: ${plantValue}`);
      
      // Process dispatch database data directly
      const dispatchData: any = {
        orderNumber: orderNumber,
        plant: plantValue,
        items: [],
        orderInfo: {}
      };
      
      // Process the first matching record from dispatch database
      if (matchingResults.length > 0) {
        const dispatchPage = matchingResults[0] as any;
        const properties = dispatchPage.properties;

        // Extract ALL properties from dispatch database
        for (const [key, value] of Object.entries(properties)) {
          const prop = value as any;

          switch (prop.type) {
            case 'title':
            case 'rich_text':
              dispatchData.orderInfo[key] = prop[prop.type]?.[0]?.plain_text || '';
              break;
            case 'date':
              const dateValue = prop.date?.start;
              if (dateValue) {
                const date = new Date(dateValue);
                dispatchData.orderInfo[key] = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
              }
              break;
            case 'select':
              dispatchData.orderInfo[key] = prop.select?.name ?? '';
              break;
            case 'multi_select':
              dispatchData.orderInfo[key] = (prop.multi_select ?? []).map((o: any) => o.name).filter(Boolean).join(', ');
              break;
            case 'formula':
              dispatchData.orderInfo[key] = prop.formula?.number || prop.formula?.string || '';
              break;
            case 'number':
              dispatchData.orderInfo[key] = prop.number || 0;
              break;
            case 'phone_number':
              dispatchData.orderInfo[key] = prop.phone_number || '';
              break;
          }
          
          // Extract product items from dispatch database (columns with quantities)
          if (prop.type === 'number' && prop.number > 0) {
            let productCode = '';
            let productName = key;
            
            // Extract product code from column name
            if (/^[A-Z]\d+/.test(key)) {
              const match = key.match(/^([A-Z]\d+)/);
              if (match) {
                productCode = match[1];
              }
            }
            
            if (productCode) {
              dispatchData.items.push({
                productCode: productCode,
                productName: productName,
                quantity: prop.number
              });
            }
          }
        }
      }
      
      // Sort items by product code for consistent display
      dispatchData.items.sort((a: any, b: any) => a.productCode.localeCompare(b.productCode));
      
      console.log(`📋 Processed ${dispatchData.items.length} items for order ${orderNumber}`);
      
      return res.status(200).json({
        success: true,
        message: `Dispatch data fetched for order ${orderNumber}`,
        data: dispatchData,
        itemCount: dispatchData.items.length
      });
      
    } catch (error: any) {
      console.error('Notion API error:', error);
      if (error.code === 'object_not_found') {
        throw new Error('Database not found. Make sure the integration has access to the database.');
      } else if (error.code === 'unauthorized') {
        throw new Error('Unauthorized access. Check if NOTION_INTEGRATION_SECRET is correct.');
      }
      throw new Error(`Notion API error: ${error.message}`);
    }
    
  } catch (error: any) {
    console.error('Dispatch preview error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch dispatch data',
      error: error.toString()
    });
  }
});

// Get list of available order numbers for dispatch preview
router.get('/dispatch-orders', async (req, res) => {
  try {
    console.log('📋 Fetching available order numbers for dispatch');
    
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
    
    // Get recent orders (limit to 100 for performance)
    const response = await notion.databases.query({
      database_id: databaseId,
      page_size: 100,
      sorts: [
        {
          property: 'For Ord Date :',
          direction: 'descending'
        }
      ]
    });
    
    const orderNumbers = new Set();
    
    response.results.forEach((page: any) => {
      if ('properties' in page) {
        const properties = page.properties;
        
        // Extract order number from various possible field names
        const orderNo = properties['For Order No. :']?.title?.[0]?.plain_text ||
                       properties['Order No. :']?.title?.[0]?.plain_text ||
                       properties['Order No.']?.title?.[0]?.plain_text ||
                       properties['For Order No. :']?.rich_text?.[0]?.plain_text ||
                       properties['Order No. :']?.rich_text?.[0]?.plain_text ||
                       properties['Order No.']?.rich_text?.[0]?.plain_text;
        
        if (orderNo && orderNo.trim()) {
          orderNumbers.add(orderNo.trim());
        }
      }
    });
    
    const orderList = Array.from(orderNumbers).sort();
    
    console.log(`📋 Found ${orderList.length} unique order numbers`);
    
    return res.status(200).json({
      success: true,
      message: `Found ${orderList.length} order numbers`,
      orders: orderList,
      count: orderList.length
    });
    
  } catch (error: any) {
    console.error('Orders fetch error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch order numbers',
      error: error.toString()
    });
  }
});

export default router;