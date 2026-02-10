import { apiRequest } from "./queryClient";

// Define the interface locally to avoid schema conflicts
export interface ProformaSlipItem {
  id: number;
  createdAt: Date | null;
  proformaSlipId: number | null;
  productId: number | null;
  quantity: number | null;
  originalQuantity: number | null;
  extraQuantity?: number | null; // Added for tracking extra quantity beyond proforma
  loadedQuantity?: number | null;
  loaded: boolean | null;
  
  // Support both naming conventions for backward compatibility
  // CamelCase names (legacy frontend)
  srNo?: number | string | null;
  srNoDisplay?: string | null;
  itemName?: string | null;
  sku?: string | null;
  
  // Underscore names (from database)
  sr_no?: number | string | null;
  sr_no_display?: string | null;
  item_name?: string | null;
  barcode?: string | null;
}

export interface ProformaSlip {
  id: number;
  orderNumber: string;
  orderDate: string | null;
  totalQuantity: number | null;
}

/**
 * Global cache for product data to speed up repeated lookups
 * Includes last accessed time for potential cache eviction in the future
 */
export const productCache: Record<number, {
  data: any;
  timestamp: number;
}> = {};

// Cache size limits and management
const MAX_CACHE_SIZE = 2000; // Max number of products to keep in cache
const CACHE_EXPIRY_TIME = 60 * 60 * 1000; // 1 hour in milliseconds

// Keep track of in-flight product batch requests to avoid redundant requests
const inFlightRequests: Map<string, Promise<Record<number, any>>> = new Map();

/**
 * Cleanup function to manage cache size and remove old entries
 * Called periodically to prevent memory issues
 */
function manageProductCache() {
  const cacheSize = Object.keys(productCache).length;
  
  // If cache is below threshold, no need to clean
  if (cacheSize < MAX_CACHE_SIZE * 0.9) return;
  
  console.log(`Product cache is approaching limit (${cacheSize}/${MAX_CACHE_SIZE}), cleaning up...`);
  
  const now = Date.now();
  const entries = Object.entries(productCache);
  
  // Sort by last accessed time (oldest first)
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
  
  // Remove oldest 20% of entries or entries older than expiry time
  const removeCount = Math.floor(cacheSize * 0.2); // Remove 20% of cache
  let removed = 0;
  
  for (const [idStr, entry] of entries) {
    // If entry is expired or we need to remove more entries
    if ((now - entry.timestamp > CACHE_EXPIRY_TIME) || (removed < removeCount)) {
      delete productCache[Number(idStr)];
      removed++;
    }
    
    // Stop once we've removed enough entries
    if (removed >= removeCount) break;
  }
  
  console.log(`Cleaned ${removed} entries from product cache`);
}

/**
 * Get product data from cache, updating the last accessed timestamp
 */
function getFromProductCache(productId: number): any | null {
  const entry = productCache[productId];
  if (!entry) return null;
  
  // Update timestamp on access
  entry.timestamp = Date.now();
  return entry.data;
}

/**
 * Add or update product data in cache with current timestamp
 */
function addToProductCache(productId: number, data: any): void {
  productCache[productId] = {
    data,
    timestamp: Date.now()
  };
  
  // Periodically check if cache needs cleanup
  if (Object.keys(productCache).length % 100 === 0) {
    manageProductCache();
  }
}

/**
 * Load products in batch to dramatically reduce API requests
 * This is the recommended way to load product data for multiple items
 */
export async function batchLoadProducts(productIds: number[]): Promise<Record<number, any>> {
  // Remove any invalid product IDs
  const validProductIds = productIds.filter(id => id && typeof id === 'number' && id > 0);
  if (validProductIds.length === 0) return {};
  
  // First, get all products that are already cached
  const cachedProducts: Record<number, any> = {};
  const uncachedProductIds: number[] = [];
  
  for (const productId of validProductIds) {
    const product = getFromProductCache(productId);
    if (product) {
      cachedProducts[productId] = product;
    } else {
      uncachedProductIds.push(productId);
    }
  }
  
  // If all products are cached, return immediately
  if (uncachedProductIds.length === 0) {
    return cachedProducts;
  }
  
  // Create a batch key to avoid duplicate requests
  const batchKey = uncachedProductIds.sort().join(',');
  
  // Check if we already have an in-flight request for this exact batch
  let batchPromise = inFlightRequests.get(batchKey);
  if (batchPromise) {
    console.log(`Reusing in-flight request for ${uncachedProductIds.length} products`);
    
    try {
      // Wait for the in-flight request and merge with cached results
      const batchResults = await batchPromise;
      return { ...cachedProducts, ...batchResults };
    } catch (error) {
      console.error('Error in reused batch load:', error);
      inFlightRequests.delete(batchKey);
      return cachedProducts; // Return what we have from cache
    }
  }
  
  // Create a new request for this batch
  console.log(`Batch loading ${uncachedProductIds.length} products...`);
  
  // Function to actually perform the batch request
  const executeBatchRequest = async (): Promise<Record<number, any>> => {
    try {
      const response = await fetch('/api/products/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: uncachedProductIds }),
      });
      
      if (!response.ok) {
        throw new Error(`Batch product loading failed: ${response.status}`);
      }
      
      const productMap = await response.json();
      
      // Store all products in cache
      for (const [idStr, product] of Object.entries(productMap)) {
        const id = parseInt(idStr);
        addToProductCache(id, product);
      }
      
      console.log(`Successfully loaded ${Object.keys(productMap).length} of ${uncachedProductIds.length} requested products`);
      return productMap;
    } catch (error) {
      console.error('Error batch loading products:', error);
      return {};
    } finally {
      // Remove from in-flight requests
      inFlightRequests.delete(batchKey);
    }
  };
  
  // Create the promise and store it in the in-flight requests map
  batchPromise = executeBatchRequest();
  inFlightRequests.set(batchKey, batchPromise);
  
  // Wait for the request to complete and merge with cached results
  try {
    const batchResults = await batchPromise;
    return { ...cachedProducts, ...batchResults };
  } catch (error) {
    return cachedProducts; // Return what we have from cache on error
  }
}

/**
 * Helper function to preload product data for all items in a slip
 * This improves the desktop view and ensures data is available before display
 */
export async function preloadProductData(items: ProformaSlipItem[]): Promise<void> {
  if (!items || items.length === 0) return;
  
  try {
    // Create a list of product IDs that aren't already cached
    const productIdsToLoad: number[] = [];
    
    // First pass - collect product IDs and use cached data immediately if available
    for (const item of items) {
      if (!item.productId) continue;
      
      // Check if product data is already in cache
      const cachedProduct = getFromProductCache(item.productId);
      if (cachedProduct) {
        // Enhance item with cached product data
        applyProductDataToItem(item, cachedProduct);
      } else {
        // Add to loading queue
        productIdsToLoad.push(item.productId);
      }
    }
    
    // If all products are already cached, exit early
    if (productIdsToLoad.length === 0) {
      console.log('All products already cached, no need to preload');
      return;
    }
    
    console.log(`Preloading ${productIdsToLoad.length} products...`);
    
    // Use batch loading for better efficiency
    const productMap = await batchLoadProducts(productIdsToLoad);
    
    // Apply product data to all matching items
    for (const item of items) {
      if (item.productId && productMap[item.productId]) {
        applyProductDataToItem(item, productMap[item.productId]);
      }
    }
    
    // Apply default values for any items that still don't have product data
    for (const item of items) {
      if (item.productId && !getFromProductCache(item.productId)) {
        // This product ID couldn't be loaded, apply defaults
        item.item_name = item.item_name || item.itemName || "Item " + item.productId;
        item.itemName = item.itemName || item.item_name || "Item " + item.productId;
        item.barcode = item.barcode || item.sku || "N/A";
        item.sku = item.sku || item.barcode || "N/A";
      }
    }
    
    console.log(`Preloaded product data for ${productIdsToLoad.length} items`);
  } catch (error) {
    console.error("Error preloading product data:", error);
  }
}

/**
 * Helper function to apply product data to an item
 */
function applyProductDataToItem(item: ProformaSlipItem, product: any): void {
  // Set both camelCase and underscore versions for consistency
  item.item_name = product.name || item.item_name;
  item.itemName = product.name || item.itemName;
  item.barcode = product.barcode || item.barcode;
  item.sku = product.barcode || item.sku;
  
  // Handle sr_no fields
  if (product.srNo) {
    item.srNo = product.srNo;
    item.sr_no = product.srNo;
    item.srNoDisplay = String(product.srNo);
    item.sr_no_display = String(product.srNo);
  }
}

/**
 * Helper function to get the item name using either field format
 * Also loads missing product data asynchronously if needed
 */
export function getItemName(item: ProformaSlipItem): string {
  // First try to get from cache for immediate response
  if (item.productId) {
    const cachedProduct = getFromProductCache(item.productId);
    if (cachedProduct) {
      return cachedProduct.name;
    }
  }
  
  // Use nullish coalescing for cleaner null/undefined handling
  // Then check item_name (database field), then itemName (legacy field)
  if (item.item_name) return item.item_name;
  if (item.itemName) return item.itemName;
  
  // If we have a product ID but no name, trigger batch loading asynchronously
  // and use a better fallback in the meantime
  if (item.productId) {
    // Lazily request the product data to be loaded in background
    const productId = item.productId;
    if (productId) {
      setTimeout(() => {
        // Use batchLoadProducts for better efficiency, even for single product
        batchLoadProducts([productId]).catch(err => 
          console.error(`Error lazy-loading product ${productId}:`, err)
        );
      }, 0);
    }
    
    return `Item ${item.productId}`;
  }
  
  // Last resort fallback for completely unknown items
  return "Unknown Item";
}

/**
 * Helper function to get the barcode/SKU using either field format
 * Also loads missing product data asynchronously if needed
 */
export function getBarcode(item: ProformaSlipItem): string {
  // First try to get from cache for immediate response
  if (item.productId) {
    const cachedProduct = getFromProductCache(item.productId);
    if (cachedProduct) {
      return cachedProduct.barcode;
    }
  }
  
  // Use nullish coalescing for cleaner null/undefined handling
  // Then check barcode (database field), then sku (legacy field)
  if (item.barcode) return item.barcode;
  if (item.sku) return item.sku;
  
  // If we have a product ID but no barcode, use batch loading (reuse same code path as getItemName)
  // and use a better fallback in the meantime
  if (item.productId) {
    // Reuse the same lazy loading mechanism as getItemName
    // We don't need to trigger it again if getItemName was already called
    const productId = item.productId;
    if (productId && !inFlightRequests.has(productId.toString())) {
      setTimeout(() => {
        batchLoadProducts([productId]).catch(err => 
          console.error(`Error lazy-loading product ${productId}:`, err)
        );
      }, 0);
    }
    
    return `ID:${item.productId}`;
  }
  
  // Last resort fallback
  return "N/A";
}

/**
 * Helper function to get the SR No using either field format
 */
export function getSrNo(item: ProformaSlipItem, idx?: number): number | string | null {
  if (item.srNo) return item.srNo;
  if (item.sr_no) return item.sr_no;
  return idx !== undefined ? idx + 1 : null;
}

/**
 * Helper function to get the SR No display string using either field format
 */
export function getSrNoDisplay(item: ProformaSlipItem): string | null {
  if (item.srNoDisplay) return item.srNoDisplay;
  if (item.sr_no_display) return item.sr_no_display;
  if (item.srNo) return String(item.srNo);
  if (item.sr_no) return String(item.sr_no);
  return null;
}

// Cache for proforma slip data to speed up repeated lookups
const proformaSlipCache: Record<string, {
  data: any;
  timestamp: number;
}> = {};

/**
 * Enhanced order lookup function that includes product data preloading
 * and proper item property handling
 */
export async function enhancedOrderLookup(orderNumber: string, setIsOrderSearchLoading: (loading: boolean) => void) {
  try {
    setIsOrderSearchLoading(true);
    const trimmedOrderNumber = orderNumber.trim();
    
    // Check if we have this proforma slip in the cache
    const cachedData = proformaSlipCache[trimmedOrderNumber];
    if (cachedData) {
      console.log(`Using cached proforma slip data for ${trimmedOrderNumber}`);
      
      // Check if operation already exists - this is still needed
      const opResponse = await apiRequest(
        'GET',
        `/api/loading-operations/reference/${trimmedOrderNumber}`
      );
      
      const opData = await opResponse.json();
      
      // Use the cached data with updated operation status
      const processedData = {
        ...cachedData.data,
        operation: opData.exists ? opData.operation : undefined
      };
      
      setIsOrderSearchLoading(false);
      return processedData;
    }
    
    // No cached data, fetch from API
    // Use batch API for better performance
    const response = await fetch('/api/proforma-slips/batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ orderNumbers: [trimmedOrderNumber] }),
    });
    
    const batchResults = await response.json();
    const data = batchResults[trimmedOrderNumber];
    
    if (!data) {
      throw new Error(`No data found for order number ${trimmedOrderNumber}`);
    }
    
    // Check if operation already exists
    const opResponse = await apiRequest(
      'GET',
      `/api/loading-operations/reference/${trimmedOrderNumber}`
    );
    
    const opData = await opResponse.json();
    
    // Process the items immediately for fast display
    const processedData = {
      slip: data.slip,
      items: data.items.map((item: any, idx: number) => {
        // Make sure all item properties are populated with basic info
        return {
          ...item,
          srNo: item.srNo || item.sr_no || idx + 1,
          srNoDisplay: item.srNoDisplay || item.sr_no_display || String(item.srNo || item.sr_no || idx + 1),
          itemName: item.itemName || item.item_name || `Item ${item.productId || idx}`,
          sku: item.sku || item.barcode || ""
        };
      }),
      operation: opData.exists ? opData.operation : undefined
    };
    
    // Store in cache for future use
    proformaSlipCache[trimmedOrderNumber] = {
      data: processedData,
      timestamp: Date.now()
    };
    
    // Preload product data in the background AFTER returning the result
    // This improves perceived performance
    setTimeout(() => {
      console.log("Background preloading product data for", data.items.length, "items...");
      preloadProductData(data.items).catch(err => {
        console.error("Error preloading product data:", err);
      });
    }, 100);
    
    setIsOrderSearchLoading(false);
    return processedData;
  } catch (error) {
    setIsOrderSearchLoading(false);
    throw error;
  }
}