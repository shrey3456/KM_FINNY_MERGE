import { Router } from 'express';
import { Client } from '@notionhq/client';
import { authenticateToken } from '../middleware/authMiddleware'; // Import middleware

const router = Router();

// Simple in-memory cache
const searchCache = new Map<string, { data: any, timestamp: number }>();
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour cache

// Toll voucher API - Protected
router.post('/toll-voucher', async (req, res) => {
  try {
    const { orderNumber } = req.body;
    
    if (!orderNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'Voucher number is required' 
      });
    }

    // Check cache first
    const cacheKey = `toll_voucher_${orderNumber}`;
    const cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      return res.json(cached.data);
    }
    
    const notion = new Client({
      auth: process.env.NOTION_INTEGRATION_SECRET,
    });
    
    // Use same expense voucher database
    const EXPENSE_VOUCHER_DATABASE_ID = '173604c4adf080f7853dc9a41a8a69a9';
    
    let allResults: any[] = [];
    let matchingResults: any[] = [];
    
    try {
      console.log(`🔍 [TOLL] Searching for voucher: ${orderNumber}`);
      
      let hasMore = true;
      let cursor: string | undefined = undefined;
      let batchCount = 0;
      const MAX_BATCHES = 2;
      
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
        
        console.log(`📄 [TOLL] Batch ${batchCount}: Fetched ${batchResults.length} records`);
        
        // Search batch for voucher
        const batchMatches = batchResults.filter((page: any) => {
          if (!('properties' in page)) return false;
          const properties = page.properties;
          
          for (const [key, value] of Object.entries(properties)) {
            const prop = value as any;
            let fieldValue = '';
            
            // FIX: Join ALL text parts. Notion splits text if formatting changes (e.g. 6617 is bold, A is normal)
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
            
            // Check for exact match or contains
            if (fieldValue) {
              // STRICT EXACT MATCH ONLY
              // We only accept if the FULL value matches exactly.
              // No partial matches allowed.
              if (fieldValue === orderNumber) {
                return true;
              }
              
              // If the field value is "6417A" and we search "6417", this is NOT a match.
              // If the field value is "6417" and we search "6417", this IS a match.
            }
          }
          
          return false;
        });
        
        if (batchMatches.length > 0) {
          console.log(`✅ [TOLL] FOUND in batch ${batchCount}!`);
          matchingResults = batchMatches;
          break;
        }
        
        hasMore = response.has_more;
        cursor = response.next_cursor || undefined;
      }
      
    } catch (error) {
      console.error('📋 [TOLL] Error fetching data:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch toll voucher data'
      });
    }
    
    if (matchingResults.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Voucher ${orderNumber} not found`
      });
    }
    
    // Process first match - extract toll-specific fields
    const firstMatch = matchingResults[0] as any;
    const properties = firstMatch.properties || {};

// DEBUG: dump property keys and a short sample so we can see exact name/type
    console.log('[TOLL] page id=', firstMatch.id, 'property keys=', Object.keys(properties).join(', '));
    for (const [k, v] of Object.entries(properties)) {
      // show type and a small sample
      try { console.log(`[TOLL] prop: "${k}" type:${v?.type} sample:`, JSON.stringify(v).slice(0,200)); }
      catch (e) { console.log('[TOLL] prop sample error', e); }
    }

// --- existing date-extraction logic (keep or add) ---
    let parsedOrderDate = '';
    try {
      // try preferred keys first (add more names if your Notion shows different keys)
      const dateCandidates = ['For Ord Date :','For Ord Date','Order Date','Order Date :','Date','Ord Date','Voucher Date','Voucher Date :'];
      let dateFound: any = null;
      for (const key of dateCandidates) {
        const p = properties[key];
        if (!p) continue;
        if (p.type === 'date' && p.date?.start) { dateFound = p.date.start; break; }
        if ((p.type === 'title' || p.type === 'rich_text') && p[p.type]?.[0]?.plain_text) { dateFound = p[p.type][0].plain_text; break; }
        if (p.type === 'formula' && (p.formula?.string || p.formula?.date?.start)) { dateFound = p.formula?.string ?? p.formula?.date?.start; break; }
      }
      // fallback: first date-type property
      if (!dateFound) {
        for (const v of Object.values(properties) as any[]) {
          if (v?.type === 'date' && v?.date?.start) { dateFound = v.date.start; break; }
        }
      }
      if (dateFound) {
        const maybe = new Date(String(dateFound));
        if (!isNaN(maybe.getTime())) {
          parsedOrderDate = `${String(maybe.getDate()).padStart(2,'0')}/${String(maybe.getMonth()+1).padStart(2,'0')}/${maybe.getFullYear()}`;
        } else parsedOrderDate = String(dateFound);
      }
      console.log('[TOLL] dateFound raw=', dateFound, 'parsedOrderDate=', parsedOrderDate);
    } catch(err) {
      console.warn('[TOLL] date parse failed', err);
    }

// ensure orderDate is attached to response object
    const tollVoucherData: any = {
      orderNumber: orderNumber,
      plant: properties['Plant']?.select?.name || properties['Stk Plant :']?.select?.name || 'INDORE',
      voucherInfo: {} as any,
      orderDate: parsedOrderDate // <- ensure this is present
    };
    
    // Extract all property data from expense voucher record (same as expense voucher)
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
        tollVoucherData.voucherInfo[key] = displayValue;
      }
    }
    
    // Extract specific fields for toll voucher (using correct field names)
    tollVoucherData.driver = tollVoucherData.voucherInfo['Link to Driver :'] || '';
    
    // Extract vehicle number - handle format like "221{GJ-15-AX-6055},221{GJ-15-AX-6055}"
    // Show only first occurrence: "221{GJ-15-AX-6055}"
    let vehicleRaw = tollVoucherData.voucherInfo['Link to Vehicle No. :'] || tollVoucherData.voucherInfo['For Vehicle '] || '';
    if (vehicleRaw) {
      // Split by comma and take first value
      tollVoucherData.vehicle = vehicleRaw.split(',')[0].trim();
    } else {
      tollVoucherData.vehicle = '';
    }
    
    tollVoucherData.tollTax = parseFloat(tollVoucherData.voucherInfo['Toll Tax :']) || 0;
    tollVoucherData.party = tollVoucherData.voucherInfo['Party x Ord Date'] || '';
    tollVoucherData.order = tollVoucherData.voucherInfo['Voucher No. :'] || orderNumber;
    
    // Convert toll tax to words (Indian number system)
    tollVoucherData.tollTaxInWords = numberToWords(tollVoucherData.tollTax);
    
    // BEFORE sending response: log final payload for verification
    const payload = {
      success: true,
      message: 'OK',
      data: tollVoucherData
    };
    console.log('[TOLL] Sending payload sample:', JSON.stringify(payload, null, 2).slice(0,2000));
    return res.json(payload);
    
  } catch (error: any) {
    console.error('Error in toll voucher endpoint:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Convert number to words (Indian format)
function numberToWords(num: number): string {
  if (num === 0) return 'Zero Rupees Only';
  
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  
  function convertLessThan100(n: number): string {
    if (n < 10) return ones[n];
    if (n >= 10 && n < 20) return teens[n - 10];
    return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + ones[n % 10] : '');
  }
  
  function convertLessThan1000(n: number): string {
    if (n === 0) return '';
    if (n < 100) return convertLessThan100(n);
    return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ' ' + convertLessThan100(n % 100) : '');
  }
  
  let result = '';
  
  // Crores
  if (num >= 10000000) {
    result += convertLessThan1000(Math.floor(num / 10000000)) + ' Crore ';
    num %= 10000000;
  }
  
  // Lakhs
  if (num >= 100000) {
    result += convertLessThan100(Math.floor(num / 100000)) + ' Lakh ';
    num %= 100000;
  }
  
  // Thousands
  if (num >= 1000) {
    result += convertLessThan100(Math.floor(num / 1000)) + ' Thousand ';
    num %= 1000;
  }
  
  // Hundreds
  if (num > 0) {
    result += convertLessThan1000(num);
  }
  
  return result.trim() + ' Rupees Only';
}

export default router;
