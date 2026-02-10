/**
 * Data loader utility for optimizing Proforma data loading
 * This helper library pre-loads and caches data to make the Edit Operation dialog
 * open super fast without waiting for API calls to complete
 */

import { ProformaSlipItem, ProformaSlip } from './productLoaderHelper';

// Cache for storing preloaded data
type ProformaCache = Record<string, {
  slip: any;
  items: any[];
  lastLoaded: number;
}>;

// In-memory cache with a 5-minute expiration
const proformaCache: ProformaCache = {};

// Maximum cache age in milliseconds (5 minutes)
const MAX_CACHE_AGE = 5 * 60 * 1000;

/**
 * Preloads proforma slip data for faster dialog opening
 * @param orderNumber The order number to preload
 * @returns Promise that resolves when data is preloaded
 */
export const preloadProformaData = async (orderNumber: string | null): Promise<boolean> => {
  if (!orderNumber) return false;
  
  const trimmedRef = orderNumber.trim();
  
  try {
    console.log(`Preloading data for ${trimmedRef} in background`);
    
    // Skip if we already have fresh data in cache
    if (
      proformaCache[trimmedRef] && 
      (Date.now() - proformaCache[trimmedRef].lastLoaded < MAX_CACHE_AGE)
    ) {
      console.log(`Using cached data for ${trimmedRef} - already preloaded`);
      return true;
    }
    
    // Use batch API for better performance
    const batchResponse = await fetch('/api/proforma-slips/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNumbers: [trimmedRef] }),
    });
    
    const batchResults = await batchResponse.json();
    const data = batchResults[trimmedRef];
    
    if (!data) {
      console.error(`No data returned for ${trimmedRef}`);
      return false;
    }
    
    // Store in our cache with current timestamp
    proformaCache[trimmedRef] = {
      slip: data.slip,
      items: data.items,
      lastLoaded: Date.now()
    };
    
    console.log(`Successfully preloaded data for ${trimmedRef}`);
    return true;
  } catch (error) {
    console.error(`Error preloading data:`, error);
    return false;
  }
};

/**
 * Gets preloaded proforma slip data 
 * @param orderNumber The order number to get
 * @returns The cached data or null if not found
 */
export const getCachedProformaData = (orderNumber: string | null): any => {
  if (!orderNumber) return null;
  
  const trimmedRef = orderNumber.trim();
  
  // Return null if no cached data or data is stale
  if (
    !proformaCache[trimmedRef] || 
    (Date.now() - proformaCache[trimmedRef].lastLoaded > MAX_CACHE_AGE)
  ) {
    return null;
  }
  
  // Return cached data
  return {
    slip: proformaCache[trimmedRef].slip,
    items: proformaCache[trimmedRef].items
  };
};

/**
 * Processes items to ensure they have consistent field naming
 * @param items List of proforma slip items to process
 * @returns Processed items with consistent naming
 */
export const processProformaItems = (items: any[]): any[] => {
  return items.map((item: any, idx: number) => ({
    ...item,
    // Ensure all required fields are present with both naming conventions
    sr_no: item.sr_no || item.srNo || idx + 1,
    sr_no_display: item.sr_no_display || item.srNoDisplay || (idx + 1).toString(),
    item_name: item.item_name || item.itemName,
    barcode: item.barcode || item.sku,
    srNo: item.sr_no || item.srNo || idx + 1,
    srNoDisplay: item.sr_no_display || item.srNoDisplay || (idx + 1).toString(),
    itemName: item.item_name || item.itemName,
    sku: item.barcode || item.sku,
    loaded: item.loaded || false,
    originalQuantity: item.originalQuantity || item.quantity || 0
  }));
};

/**
 * Updates an item's loaded status in the proforma slip cache
 * This ensures immediately updated UI when toggling loaded status
 * 
 * @param referenceNumber The order reference number
 * @param itemId The ID of the item to update
 * @param loaded The new loaded status (true/false)
 * @returns True if update was successful, false otherwise
 */
/**
 * Product cache to avoid repeated API calls
 */
const productCache: Record<number, any> = {};

/**
 * Batch loads products by IDs to avoid individual API calls
 * @param productIds Array of product IDs to load
 * @returns Promise that resolves to a map of products by ID
 */
export const batchLoadProducts = async (productIds: number[]): Promise<Record<number, any>> => {
  // First, filter out any IDs we already have in cache
  const missingProductIds = productIds.filter(id => !productCache[id]);
  
  if (missingProductIds.length === 0) {
    console.log('All products already in cache, skipping API call');
    // Return a map of the requested products from cache
    return productIds.reduce((map: Record<number, any>, id) => {
      map[id] = productCache[id];
      return map;
    }, {});
  }
  
  console.log(`Batch loading ${missingProductIds.length} products...`);
  try {
    const response = await fetch('/api/products/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds: missingProductIds }),
    });
    
    if (!response.ok) {
      throw new Error(`Batch product loading failed: ${response.status}`);
    }
    
    const productMap = await response.json();
    
    // Update the cache with new products
    Object.keys(productMap).forEach(idStr => {
      const id = parseInt(idStr);
      productCache[id] = productMap[id];
    });
    
    console.log(`Loaded ${Object.keys(productMap).length}/${missingProductIds.length} products...`);
    
    // Return a map of all requested products (both from cache and newly loaded)
    return productIds.reduce((map: Record<number, any>, id) => {
      map[id] = productCache[id];
      return map;
    }, {});
  } catch (error) {
    console.error('Error batch loading products:', error);
    return {};
  }
};

export const updateProformaSlipItemCache = (
  referenceNumber: string | null | undefined,
  itemId: number,
  loaded: boolean
): boolean => {
  if (!referenceNumber) return false;
  
  const trimmedRef = referenceNumber.trim();
  
  try {
    // Check if we have this reference number in the cache
    if (!proformaCache[trimmedRef]) {
      console.log(`No cached data for ${trimmedRef} to update item ${itemId}`);
      return false;
    }
    
    // Clone the cached data to avoid mutating it directly
    const data = { ...proformaCache[trimmedRef] };
    let updated = false;
    
    // Find and update the specific item
    if (data.items && Array.isArray(data.items)) {
      data.items = data.items.map(item => {
        if (item.id === itemId) {
          updated = true;
          return { ...item, loaded };
        }
        return item;
      });
      
      // Only update the cache if we actually changed something
      if (updated) {
        // Update timestamp to reflect this is fresh data
        data.lastLoaded = Date.now();
        proformaCache[trimmedRef] = data;
        console.log(`Updated item ${itemId} loaded status to ${loaded} in proforma cache for ${trimmedRef}`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error(`Error updating proforma cache:`, error);
    return false;
  }
};

/**
 * Background preloads data for all available operations to make navigation extremely fast
 * @param operations Array of operations to preload
 */
export const preloadAllOperationsData = async (operations: any[]): Promise<void> => {
  // Extract unique order numbers
  const uniqueOrderNumbers = Array.from(new Set(
    operations
      .filter(op => op.referenceNumber)
      .map(op => op.referenceNumber.trim())
  ));
  
  // Only process a batch of 10 at a time to avoid overwhelming the server
  const BATCH_SIZE = 10;
  
  // Process in batches
  for (let i = 0; i < uniqueOrderNumbers.length; i += BATCH_SIZE) {
    const batch = uniqueOrderNumbers.slice(i, i + BATCH_SIZE);
    
    // We don't need to await this - let it happen in the background
    setTimeout(async () => {
      try {
        // Use batch API for better performance
        const batchResponse = await fetch('/api/proforma-slips/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderNumbers: batch }),
        });
        
        const batchResults = await batchResponse.json();
        
        // Store each result in cache
        for (const orderNumber of batch) {
          const data = batchResults[orderNumber];
          
          if (data) {
            proformaCache[orderNumber] = {
              slip: data.slip,
              items: data.items,
              lastLoaded: Date.now()
            };
          }
        }
        
        console.log(`Background preloaded batch of ${batch.length} operations`);
      } catch (error) {
        console.error(`Error in background preloading:`, error);
      }
    }, 500 * (i / BATCH_SIZE)); // Stagger the batches to avoid overloading
  }
};