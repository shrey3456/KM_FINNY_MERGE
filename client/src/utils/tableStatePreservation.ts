import { useEffect } from 'react';

interface CacheEntry {
  data: any[];
  timestamp: number;
}

const tableStateCache = new Map<string, CacheEntry>();
const operationCache = new Map<number, any>();

/**
 * Cache a specific operation by its ID for direct access
 * @param operation The operation object to cache
 */
export function updateCachedOperation(operation: any) {
  if (operation && operation.id) {
    // Cache the single operation for direct access
    operationCache.set(operation.id, {
      ...operation,
      _updatedAt: Date.now()
    });
    
    // Also update in the table state cache if it exists
    const tableKey = '/api/loading-operations';
    const entry = tableStateCache.get(tableKey);
    
    if (entry?.data) {
      const updatedTableData = entry.data.map(op => 
        op.id === operation.id ? { ...op, ...operation } : op
      );
      
      tableStateCache.set(tableKey, {
        data: updatedTableData,
        timestamp: Date.now()
      });
      
      console.log(`Updated operation ${operation.id} in table cache. Vehicle number is now ${operation.vehicleNumber}`);
    }
  }
}

/**
 * Get a cached operation by its ID
 * @param id The operation ID to retrieve
 * @returns The cached operation or undefined if not found
 */
export function getCachedOperation(id: number) {
  return operationCache.get(id);
}

export function preserveTableState(key: string, data: any[]) {
  if (data && data.length > 0) {
    tableStateCache.set(key, {
      data,
      timestamp: Date.now()
    });
    
    // Cache individual operations for direct access
    if (key === '/api/loading-operations') {
      data.forEach(operation => {
        if (operation && operation.id) {
          operationCache.set(operation.id, {
            ...operation,
            _updatedAt: Date.now()
          });
        }
      });
    }
  }
}

export function getPreservedTableState(key: string) {
  const entry = tableStateCache.get(key);
  return entry?.data || [];
}

export function clearTableState(key: string) {
  tableStateCache.delete(key);
}

export function useTableStatePreservation(key: string, data: any[]) {
  useEffect(() => {
    if (data?.length > 0) {
      preserveTableState(key, data);
    }
  }, [key, data]);

  return getPreservedTableState(key);
}

// Export cleanup function for manual cleanup
export function cleanupTableCache() {
  tableStateCache.clear();
  operationCache.clear();
}

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, cache] of tableStateCache.entries()) {
    if (now - cache.timestamp > 3600000) { // 1 hour
      tableStateCache.delete(id);
    }
  }
  
  for (const [id, operation] of operationCache.entries()) {
    if (now - (operation._updatedAt || 0) > 3600000) { // 1 hour
      operationCache.delete(id);
    }
  }
}, 3600000);