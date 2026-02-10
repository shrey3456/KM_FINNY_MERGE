import { Router } from 'express';
import { Client } from '@notionhq/client';
import { authenticateToken } from '../middleware/authMiddleware'; // Import middleware

const router = Router();

// Simple in-memory cache to speed up repeated searches
const searchCache = new Map<string, { data: any, timestamp: number }>();
const partyCache = new Map<string, { data: any, timestamp: number }>();
const CACHE_DURATION = (60 * 1000)/2; // 1 hour cache for maximum speed

// Expense voucher API - Protected
router.post('/expense-voucher', async (req, res) => {
  try {
    const { orderNumber } = req.body;
    
    if (!orderNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'Voucher number is required' 
      });
    }

    // Check cache first
    const cacheKey = `expense_voucher_${orderNumber}`;
    const cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      // Cache hit
      return res.json(cached.data);
    }
    
    const notion = new Client({
      auth: process.env.NOTION_INTEGRATION_SECRET,
    });
    
    // Extract database ID from the provided URL: https://www.notion.so/kmfinny/173604c4adf080f7853dc9a41a8a69a9?v=173604c4adf08158ba8a000c964da041&source=copy_link
    const EXPENSE_VOUCHER_DATABASE_ID = '173604c4adf080f7853dc9a41a8a69a9';
    
    // Diesel bill database ID from: https://www.notion.so/kmfinny/dfba335ed74d4cd991b5b1a597c90605?v=a1866200419647f898d21f0fb6983a47&source=copy_link
    const DIESEL_BILL_DATABASE_ID = 'dfba335ed74d4cd991b5b1a597c90605';
    
    // Order details database ID from: https://www.notion.so/kmfinny/296851d9af9e4a14966376e58f8475e5?v=71fd049ebcc042dba43cc985ac6520a0&source=copy_link
    const ORDER_DETAILS_DATABASE_ID = '296851d9af9e4a14966376e58f8475e5';
    
    // Driver database ID from: https://www.notion.so/kmfinny/7ac590de16e645cb96478236d5c47618?v=af0c988b17994ba7b7bdcce02f0a0cc2&source=copy_link
    const DRIVER_DATABASE_ID = '7ac590de16e645cb96478236d5c47618';
    
    const PARTY_DATABASE_ID = '0da8aefd54554a75971f3726eaabcd42';
    
    try {
      // Simple query without any filters
      // Fetching records
      
      // Fetch records with smart batching and early exit
      console.log(`🔍 Searching for voucher: ${orderNumber}`);
      let allResults: any[] = [];
      let matchingResults: any[] = [];
      
      try {
        // Fetch in small batches and check after each batch (early exit when found)
        console.log(`📅 Fetching recent records (newest first)...`);
        
        let hasMore = true;
        let cursor: string | undefined = undefined;
        let batchCount = 0;
        const MAX_BATCHES = 2; // Only fetch 200 records max (2 batches of 100)
        
        while (hasMore && batchCount < MAX_BATCHES && matchingResults.length === 0) {
          const response = await notion.databases.query({
            database_id: EXPENSE_VOUCHER_DATABASE_ID,
            page_size: 100,
            start_cursor: cursor,
            sorts: [
              {
                timestamp: 'created_time',
                direction: 'descending'
              }
            ]
          });
          
          batchCount++;
          const batchResults = response.results;
          allResults = allResults.concat(batchResults);
          
          console.log(`📄 Batch ${batchCount}: Fetched ${batchResults.length} records, total: ${allResults.length}`);
          
          // Search THIS batch immediately for early exit
          const batchMatches = batchResults.filter((page: any) => {
            if (!('properties' in page)) return false;
            const properties = page.properties;
            
            // Check ALL fields for the voucher number
            for (const [key, value] of Object.entries(properties)) {
              const prop = value as any;
              let fieldValue = '';
              
              // FIX: Join ALL text parts. Notion splits text if formatting changes
              if (prop.rich_text && Array.isArray(prop.rich_text)) {
                fieldValue = prop.rich_text.map((t: any) => t.plain_text).join('');
              } else if (prop.title && Array.isArray(prop.title)) {
                fieldValue = prop.title.map((t: any) => t.plain_text).join('');
              } else if (prop.formula?.string) {
                fieldValue = prop.formula.string;
              } else if (prop.formula?.number) {
                fieldValue = prop.formula.number.toString();
              } else if (prop.number) {
                fieldValue = prop.number.toString();
              } else if (prop.select?.name) {
                fieldValue = prop.select.name;
              }
              
              // Check for exact match ONLY
              // If searching for "6417", we do NOT want "6417A"
              if (fieldValue && fieldValue === orderNumber) {
                return true;
              }
            }
            
            return false;
          });
          
          if (batchMatches.length > 0) {
            console.log(`✅ FOUND in batch ${batchCount}! Stopping search.`);
            matchingResults = batchMatches;
            break; // Early exit - found it!
          }
          
          hasMore = response.has_more;
          cursor = response.next_cursor || undefined;
        }
        
        console.log(`✅ Search complete: ${allResults.length} records checked, ${matchingResults.length} matches found`);
        
      } catch (error) {
        console.error('📋 Error fetching expense voucher data:', error);
        return res.status(500).json({
          success: false,
          message: 'Failed to fetch expense voucher data'
        });
      }
      
      // Check if we found any matches
      if (matchingResults.length === 0) {
        return res.status(404).json({
          success: false,
          message: `Voucher ${orderNumber} not found in expense voucher database`
        });
      }
      
      // Process first matching result
      const firstMatch = matchingResults[0] as any;
      const properties = firstMatch.properties;
      
      const expenseVoucherData: any = {
        orderNumber: orderNumber,
        plant: properties['Plant']?.select?.name || properties['Stk Plant :']?.select?.name || 'INDORE',
        status: properties['Finny Status :']?.status?.name || properties['Finny Status :']?.select?.name || 'Unknown',
        items: [],
        voucherInfo: {} as any
      };
      
      // Extract all property data from expense voucher record
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
          expenseVoucherData.voucherInfo[key] = displayValue;
        }
      }
      

      // Fetch related diesel bill details if diesel bill number exists
      let dieselBillDetails = null;
      const dieselBillNo = expenseVoucherData.voucherInfo['For Diesel Bill No. :'];
      
      if (dieselBillNo) {
        try {
          // Search diesel bill database efficiently
          let dieselResponse = await notion.databases.query({
            database_id: DIESEL_BILL_DATABASE_ID,
            page_size: 50
          });
            
            // Find matching diesel bill record
            const matchingDieselResults = dieselResponse.results.filter((page: any) => {
              if (!('properties' in page)) return false;
              const properties = page.properties;
              
              // Check ALL fields for the diesel bill number
              for (const [key, value] of Object.entries(properties)) {
                const prop = value as any;
                let fieldValue = '';
                
                if (prop.rich_text?.[0]?.plain_text) {
                  fieldValue = prop.rich_text[0].plain_text;
                } else if (prop.title?.[0]?.plain_text) {
                  fieldValue = prop.title[0].plain_text;
                } else if (prop.formula?.string) {
                  fieldValue = prop.formula.string;
                } else if (prop.number) {
                  fieldValue = prop.number.toString();
                } else if (prop.select?.name) {
                  fieldValue = prop.select.name;
                }
                
                if (fieldValue && (fieldValue === dieselBillNo || fieldValue.includes(dieselBillNo))) {
                  return true;
                }
              }
              
              return false;
            });
            
            if (matchingDieselResults.length > 0) {
              const dieselRecord = matchingDieselResults[0] as any;
              const dieselProperties = dieselRecord.properties;
              
              dieselBillDetails = {} as any;
              
              // Extract all property data from diesel bill record
              for (const [key, value] of Object.entries(dieselProperties)) {
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
                }
                
                if (displayValue) {
                  dieselBillDetails[key] = displayValue;
                }
              }
              
            } else {
            }
            
          } catch (dieselError) {
            // Silently handle diesel error
          }
          
      }
      
      // Fetch related order details if available
      let orderDetails = null;
      const relatedOrderNumber = expenseVoucherData.voucherInfo['ORD{25-26-Current}'] || expenseVoucherData.voucherInfo['Order-Date :'];
      
      if (relatedOrderNumber) {
        try {
          
          let orderResponse;
          try {
            let allOrderResults: any[] = [];
            let orderCursor = undefined;
            let orderBatchCount = 0;
            
            do {
              let orderBatchResponse = await notion.databases.query({
                database_id: ORDER_DETAILS_DATABASE_ID,
                page_size: 100,
                start_cursor: orderCursor
              });
              
              allOrderResults = allOrderResults.concat(orderBatchResponse.results);
              orderCursor = orderBatchResponse.has_more ? orderBatchResponse.next_cursor : undefined;
              orderBatchCount++;
              
              // Check if we found our target order in this batch
              const foundOrderInBatch = orderBatchResponse.results.some((page: any) => {
                if (!('properties' in page)) return false;
                const props = page.properties;
                
                for (const [key, value] of Object.entries(props)) {
                  const prop = value as any;
                  let fieldValue = '';
                  
                  if (prop.rich_text?.[0]?.plain_text) {
                    fieldValue = prop.rich_text[0].plain_text;
                  } else if (prop.title?.[0]?.plain_text) {
                    fieldValue = prop.title[0].plain_text;
                  } else if (prop.formula?.string) {
                    fieldValue = prop.formula.string;
                  } else if (prop.number) {
                    fieldValue = prop.number.toString();
                  }
                  
                  if (fieldValue && (fieldValue === relatedOrderNumber || fieldValue.includes(relatedOrderNumber))) {
                    return true;
                  }
                }
                return false;
              });
              
              if (foundOrderInBatch) {
                break;
              }
              
            } while (orderCursor && orderBatchCount < 3);
            
            orderResponse = { results: allOrderResults };
            
            const matchingOrderResults = orderResponse.results.filter((page: any) => {
              if (!('properties' in page)) return false;
              const properties = page.properties;
              
              for (const [key, value] of Object.entries(properties)) {
                const prop = value as any;
                let fieldValue = '';
                
                if (prop.rich_text?.[0]?.plain_text) {
                  fieldValue = prop.rich_text[0].plain_text;
                } else if (prop.title?.[0]?.plain_text) {
                  fieldValue = prop.title[0].plain_text;
                } else if (prop.formula?.string) {
                  fieldValue = prop.formula.string;
                } else if (prop.number) {
                  fieldValue = prop.number.toString();
                } else if (prop.select?.name) {
                  fieldValue = prop.select.name;
                }
                
                if (fieldValue && (fieldValue === relatedOrderNumber || fieldValue.includes(relatedOrderNumber))) {
                  return true;
                }
              }
              
              return false;
            });
            
            if (matchingOrderResults.length > 0) {
              const orderRecord = matchingOrderResults[0] as any;
              const orderProperties = orderRecord.properties;
              
              orderDetails = {} as any;
              
              for (const [key, value] of Object.entries(orderProperties)) {
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
                }
                
                if (displayValue) {
                  orderDetails[key] = displayValue;
                }
              }
              
            }
            
          } catch (orderError) {
            console.error('📦 Error fetching order details:', orderError);
          }
          
        } catch (error) {
          console.error('📦 Error in order details lookup:', error);
        }
      }

      // Fetch driver details if available
      let driverDetails = null;
      const driverName = expenseVoucherData.voucherInfo['Link to Driver'] || expenseVoucherData.voucherInfo['Driver :'] || expenseVoucherData.voucherInfo['Driver - Aadhar Wise Name :'];
      
      if (driverName) {
        try {
          
          let driverResponse;
          try {
            let allDriverResults: any[] = [];
            let driverCursor = undefined;
            let driverBatchCount = 0;
            
            do {
              let driverBatchResponse = await notion.databases.query({
                database_id: DRIVER_DATABASE_ID,
                page_size: 100,
                start_cursor: driverCursor
              });
              
              allDriverResults = allDriverResults.concat(driverBatchResponse.results);
              driverCursor = driverBatchResponse.has_more ? driverBatchResponse.next_cursor : undefined;
              driverBatchCount++;
              
              const foundDriverInBatch = driverBatchResponse.results.some((page: any) => {
                if (!('properties' in page)) return false;
                const props = page.properties;
                
                for (const [key, value] of Object.entries(props)) {
                  const prop = value as any;
                  let fieldValue = '';
                  
                  if (prop.rich_text?.[0]?.plain_text) {
                    fieldValue = prop.rich_text[0].plain_text;
                  } else if (prop.title?.[0]?.plain_text) {
                    fieldValue = prop.title[0].plain_text;
                  } else if (prop.formula?.string) {
                    fieldValue = prop.formula.string;
                  } else if (prop.select?.name) {
                    fieldValue = prop.select.name;
                  }
                  
                  if (fieldValue && (fieldValue === driverName || fieldValue.includes(driverName))) {
                    return true;
                  }
                }
                return false;
              });
              
              if (foundDriverInBatch) {
                break;
              }
              
            } while (driverCursor && driverBatchCount < 3);
            
            driverResponse = { results: allDriverResults };
            
            const matchingDriverResults = driverResponse.results.filter((page: any) => {
              if (!('properties' in page)) return false;
              const properties = page.properties;
              
              for (const [key, value] of Object.entries(properties)) {
                const prop = value as any;
                let fieldValue = '';
                
                if (prop.rich_text?.[0]?.plain_text) {
                  fieldValue = prop.rich_text[0].plain_text;
                } else if (prop.title?.[0]?.plain_text) {
                  fieldValue = prop.title[0].plain_text;
                } else if (prop.formula?.string) {
                  fieldValue = prop.formula.string;
                } else if (prop.select?.name) {
                  fieldValue = prop.select.name;
                }
                
                if (fieldValue && (fieldValue === driverName || fieldValue.includes(driverName))) {
                  return true;
                }
              }
              
              return false;
            });
            
            if (matchingDriverResults.length > 0) {
              const driverRecord = matchingDriverResults[0] as any;
              const driverProperties = driverRecord.properties;
              
              driverDetails = {} as any;
              
              for (const [key, value] of Object.entries(driverProperties)) {
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
                  case 'phone_number':
                    displayValue = prop.phone_number || '';
                    break;
                }
                
                if (displayValue) {
                  driverDetails[key] = displayValue;
                }
              }
              
            }
            
          } catch (driverError) {
            console.error('👤 Error fetching driver details:', driverError);
          }
          
        } catch (error) {
          console.error('👤 Error in driver details lookup:', error);
        }
      }
      
      // Add all additional details to the expense voucher data
      if (dieselBillDetails) {
        expenseVoucherData.dieselBillDetails = dieselBillDetails;
      }
      if (orderDetails) {
        expenseVoucherData.orderDetails = orderDetails;
      }
      if (driverDetails) {
        expenseVoucherData.driverDetails = driverDetails;
      }
      
      const result = {
        success: true,
        message: `Voucher ${orderNumber} found`,
        data: expenseVoucherData,
        itemCount: 0
      };
      
      // Cache the successful result
      searchCache.set(cacheKey, { data: result, timestamp: Date.now() });
      
      return res.json(result);
      
    } catch (error) {
      console.error('📋 Error in expense voucher search:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to search expense voucher database'
      });
    }
    
  } catch (error) {
    console.error('📋 Error in expense voucher route:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

export default router;