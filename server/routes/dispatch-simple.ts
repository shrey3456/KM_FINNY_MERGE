import { Router } from 'express';
import { Client } from '@notionhq/client';

const router = Router();

// Simple in-memory cache to speed up repeated searches
const searchCache = new Map<string, { data: any, timestamp: number }>();
const partyCache = new Map<string, { data: any, timestamp: number }>();
const CACHE_DURATION = 0 * 1000; // 1 hour cache for maximum speed

// Simple dispatch API without any filtering
router.post('/dispatch', async (req, res) => {
  try {
    // Fast dispatch API
    
    const { orderNumber } = req.body;
    
    if (!orderNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'Order number is required' 
      });
    }

    // Search initiated
    
    // Check cache first
    const cacheKey = `dispatch_${orderNumber}`;
    const cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      // Cache hit
      return res.json(cached.data);
    }
    
    const notion = new Client({
      auth: process.env.NOTION_INTEGRATION_SECRET,
    });
    
    const DISPATCH_DATABASE_ID = '296851d9af9e4a14966376e58f8475e5';
    const PARTY_DATABASE_ID = '0da8aefd54554a75971f3726eaabcd42';
    
    try {
      // Simple query without any filters
      // Fetching records
      
      // Optimization 1: Use filters to narrow down search
      // Try filtering by order number first
      let response: any;
      try {
        // Filtered search for order
        // Try different filter approaches
        const numericOrderNumber = parseInt(orderNumber);
        const filters = [];
        
        // Always try text search for Order No.
        filters.push({
          property: 'Order No. :',
          rich_text: {
            contains: orderNumber
          }
        });
        
        // Only add numeric filter if order number is actually numeric
        if (!isNaN(numericOrderNumber)) {
          filters.push({
            property: 'Link to Order No. :',
            formula: {
              number: {
                equals: numericOrderNumber
              }
            }
          });
        }
        
        response = await notion.databases.query({
          database_id: DISPATCH_DATABASE_ID,
          filter: {
            or: filters
          },
          page_size: 10
        });
        // Success - use filtered results
      } catch (filterError) {
        // Fallback to manual search
        // Fallback: Use optimized batch fetching with early termination
        let allResults: any[] = [];
        let cursor = undefined;
        let batchCount = 0;
        
        do {
          const batchResponse = await notion.databases.query({
            database_id: DISPATCH_DATABASE_ID,
            page_size: 10,
            start_cursor: cursor,
            sorts: [
              {
                property: 'Order No. :',
                direction: 'descending'
              }
            ]
          });
          
          allResults = allResults.concat(batchResponse.results);
          cursor = batchResponse.has_more ? batchResponse.next_cursor : undefined;
          batchCount++;
          
          // Batch processed
          
          // Check if we found our target order in this batch
          const foundInBatch = batchResponse.results.some((page: any) => {
            const props = page.properties;
            const linkOrderNo = props['Link to Order No. :']?.formula?.string || '';
            const orderNo = props['Order No. :']?.rich_text?.[0]?.plain_text || '';
            return linkOrderNo.includes(orderNumber) || orderNo.includes(orderNumber);
          });
          
          if (foundInBatch) {
            break;
          }
          
        } while (cursor && batchCount < 1); // Ultra fast - only 1 batch
        
        response = { results: allResults };
      }
      
      // Quick check if we have results
      if (response.results.length === 0) {
        return res.status(404).json({
          success: false,
          message: `Order ${orderNumber} not found in dispatch database`
        });
      }
      
      // Minimal logging for performance
      
      // Search manually through results with more flexible matching
      const matchingResults = response.results.filter((page: any) => {
        if (!('properties' in page)) return false;
        const properties = page.properties;
        
        // Check "Link to Order No. :" field with all possible types
        const linkField = properties['Link to Order No. :'];
        let linkOrderNo = '';
        if (linkField) {
          linkOrderNo = linkField.formula?.string || 
                       linkField.formula?.number?.toString() || 
                       linkField.rich_text?.[0]?.plain_text || 
                       linkField.title?.[0]?.plain_text || 
                       linkField.rollup?.array?.[0]?.rich_text?.[0]?.plain_text || '';
        }
        
        // Check other order number fields as backup
        const orderNoField = properties['Order No. :'] || properties['Order No.'];
        let orderNo = '';
        if (orderNoField) {
          orderNo = orderNoField.rich_text?.[0]?.plain_text || 
                   orderNoField.title?.[0]?.plain_text || 
                   orderNoField.number?.toString() || '';
        }
        
        // Check if order matches - more flexible matching
        const isOrderMatch = linkOrderNo === orderNumber || orderNo === orderNumber ||
                            linkOrderNo.includes(orderNumber) || orderNo.includes(orderNumber);
        
        return isOrderMatch;
      });
      
      // Quick validation
      
      if (matchingResults.length === 0) {
        return res.status(404).json({
          success: false,
          message: `Order ${orderNumber} not found in dispatch database`
        });
      }
      
      // Process first matching result
      const firstMatch = matchingResults[0] as any;
      const properties = firstMatch.properties;
      
      const dispatchData: any = {
        orderNumber: orderNumber,
        plant: properties['Plant']?.select?.name || properties['Stk Plant :']?.select?.name || 'VALSAD',
        status: properties['Finny Status :']?.status?.name || properties['Finny Status :']?.select?.name || 'Unknown',
        items: [],
        orderInfo: {} as any
      };
      
      // Extract all property data from dispatch record
      for (const [key, value] of Object.entries(properties)) {
        const prop = value as any;
        let displayValue = '';
        
        switch (prop.type) {
          case 'title':
          case 'rich_text':
            displayValue = prop[prop.type]?.[0]?.plain_text || '';
            break;
          case 'date':
            if (prop.date?.start) {
              const date = new Date(prop.date.start);
              displayValue = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
            }
            break;
          case 'select':
            displayValue = prop.select?.name || '';
            break;
          case 'number':
            displayValue = prop.number?.toString() || '';
            break;
          case 'formula':
            if (prop.formula?.string) {
              displayValue = prop.formula.string;
            } else if (prop.formula?.number) {
              displayValue = prop.formula.number.toString();
            }
            break;
          case 'rollup':
            if (prop.rollup?.array && prop.rollup.array.length > 0) {
              const firstItem = prop.rollup.array[0];
              if (firstItem?.rich_text?.[0]?.plain_text) {
                displayValue = firstItem.rich_text[0].plain_text;
              } else if (firstItem?.title?.[0]?.plain_text) {
                displayValue = firstItem.title[0].plain_text;
              } else if (firstItem?.phone_number) {
                displayValue = firstItem.phone_number;
              }
            }
            break;
          case 'phone_number':
            displayValue = prop.phone_number || '';
            break;
        }
        
        if (displayValue) {
          dispatchData.orderInfo[key] = displayValue;
        }
        
        // Contact fields processed silently for speed
      }

      // Party contact info is already in dispatch database - no additional lookup needed
      
      // Order processed successfully
      
      const result = {
        success: true,
        message: `Order ${orderNumber} found`,
        data: dispatchData,
        itemCount: 0
      };
      
      // Cache the successful result
      searchCache.set(cacheKey, { data: result, timestamp: Date.now() });
      
      return res.json(result);
      
    } catch (error) {
      console.error('📋 Error in simple dispatch search:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to search dispatch database'
      });
    }
    
  } catch (error) {
    console.error('📋 Error in dispatch route:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

export default router;