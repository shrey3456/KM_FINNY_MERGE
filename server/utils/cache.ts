/**
 * Simple in-memory cache implementation with TTL support
 * Used to improve performance of frequently accessed data
 */

type CacheOptions = {
  ttl?: number; // Time to live in seconds
};

type CacheEntry<T> = {
  data: T;
  expireAt: number;
};

class MemoryCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  
  /**
   * Get an item from the cache
   * @param key Cache key
   * @returns The cached value or undefined if not found or expired
   */
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    
    // Return undefined if no entry exists or if it has expired
    if (!entry || entry.expireAt <= Date.now()) {
      if (entry) {
        // Remove expired entry
        this.cache.delete(key);
      }
      return undefined;
    }
    
    return entry.data;
  }
  
  /**
   * Set an item in the cache with an optional TTL
   * @param key Cache key
   * @param value Value to cache
   * @param ttl Time to live in seconds (optional, default: 60)
   */
  set<T>(key: string, value: T, ttl: number = 60): void {
    const expireAt = Date.now() + (ttl * 1000);
    this.cache.set(key, { data: value, expireAt });
  }
  
  /**
   * Remove an item from the cache
   * @param key Cache key
   * @returns Whether the item was successfully removed
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }
  
  /**
   * Get an item from cache, or compute and cache it if not found
   * @param key Cache key
   * @param factory Function to generate the value if not in cache
   * @param options Cache options
   * @returns The cached or computed value
   */
  async getOrSet<T>(
    key: string, 
    factory: () => Promise<T>, 
    options: CacheOptions = {}
  ): Promise<T> {
    // Try to get from cache first
    const cachedValue = this.get<T>(key);
    if (cachedValue !== undefined) {
      return cachedValue;
    }
    
    // Compute the value if not in cache
    const value = await factory();
    
    // Store in cache with TTL
    this.set(key, value, options.ttl);
    
    return value;
  }
  
  /**
   * Clear all items from the cache
   */
  clear(): void {
    this.cache.clear();
  }
  
  /**
   * Check if a key exists in the cache and is not expired
   * @param key Cache key
   * @returns Whether the key exists and is valid
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry || entry.expireAt <= Date.now()) {
      return false;
    }
    return true;
  }
  
  /**
   * Get the number of items in the cache
   */
  get size(): number {
    return this.cache.size;
  }
  
  /**
   * Remove all expired entries from the cache
   * @returns Number of entries removed
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    
    // Convert to Array before iterating to avoid TS downlevelIteration issues
    Array.from(this.cache.entries()).forEach(([key, entry]) => {
      if (entry.expireAt <= now) {
        this.cache.delete(key);
        removed++;
      }
    });
    
    return removed;
  }
}

// Create cache instances for different data types
export const itemsCache = new MemoryCache();
export const operationsCache = new MemoryCache();
export const productsCache = new MemoryCache();

// Set up periodic cleanup to prevent memory leaks (every 5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Run cleanup on all caches periodically
setInterval(() => {
  const itemsRemoved = itemsCache.cleanup();
  const opsRemoved = operationsCache.cleanup();
  const productsRemoved = productsCache.cleanup();
  
  const totalRemoved = itemsRemoved + opsRemoved + productsRemoved;
  if (totalRemoved > 0) {
    console.log(`Cache cleanup: removed ${totalRemoved} expired entries (items: ${itemsRemoved}, operations: ${opsRemoved}, products: ${productsRemoved})`);
  }
}, CLEANUP_INTERVAL_MS);

// Export the cache class for other modules to create their own cache instances
export default MemoryCache;