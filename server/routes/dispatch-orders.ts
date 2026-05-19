import { Router } from 'express';
import { Client } from '@notionhq/client';

const router = Router();

// Get available order numbers for dispatch (only dispatched & ready for dispatch)
router.get('/dispatch-orders', async (req, res) => {
  try {
    console.log('📋 Fetching available order numbers for dispatch');
    
    // Initialize Notion client
    const notion = new Client({
      auth: process.env.NOTION_INTEGRATION_SECRET,
    });
    
    // Use order database to get orders with correct status
    const ORDER_DATABASE_ID = process.env.ORDER_DATABASE_ID;
    
    if (!ORDER_DATABASE_ID) {
      return res.status(500).json({
        success: false,
        message: 'ORDER_DATABASE_ID environment variable is not set'
      });
    }
    
    // Query for orders with dispatched or ready for dispatch status (only 10 recent orders)
    const response = await notion.databases.query({
      database_id: ORDER_DATABASE_ID,
      filter: {
        or: [
          {
            property: 'Status',
            select: {
              equals: 'Dispatched'
            }
          },
          {
            property: 'Status',
            select: {
              equals: 'Ready for Dispatch'
            }
          }
        ]
      },
      page_size: 10,
      sorts: [
        {
          property: 'Link to Order No. :',
          direction: 'descending'
        }
      ]
    });
    
    // Extract unique order numbers
    const orderNumbers = new Set<string>();
    
    response.results.forEach((page: any) => {
      if ('properties' in page) {
        const properties = page.properties;
        
        // Get order number from "Link to Order No. :" field
        const orderNo = properties['Link to Order No. :']?.rich_text?.[0]?.plain_text ||
                        properties['Link to Order No. :']?.title?.[0]?.plain_text ||
                        properties['Order No.']?.rich_text?.[0]?.plain_text ||
                        properties['Order No.']?.title?.[0]?.plain_text || '';
        
        if (orderNo && orderNo.trim()) {
          orderNumbers.add(orderNo.trim());
        }
      }
    });
    
    const orderList = Array.from(orderNumbers)
      .sort((a, b) => {
        // Sort numerically if both are numbers, otherwise alphabetically
        const numA = parseInt(a);
        const numB = parseInt(b);
        if (!isNaN(numA) && !isNaN(numB)) {
          return numB - numA; // Descending order for recent orders first
        }
        return b.localeCompare(a); // Descending alphabetical
      })
      .slice(0, 10); // Take only the first 10 orders
    
    console.log(`📋 Found ${orderList.length} recent order numbers`);
    
    res.json({
      success: true,
      orders: orderList,
      count: orderList.length,
      message: `Found ${orderList.length} recent orders with dispatched/ready for dispatch status`
    });
    
  } catch (error) {
    console.error('Dispatch orders fetch error:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Failed to fetch dispatch orders'
    });
  }
});

export default router;