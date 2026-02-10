import fs from 'fs';
import path from 'path';
import { LoadingOperation, Sale } from '@shared/schema';
import { apiRequest } from '../../client/src/lib/queryClient';

// Define the backup directory
const BACKUP_DIR = path.join(__dirname, 'data');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Define paths for backup files
const LOADING_OPS_FILE = path.join(BACKUP_DIR, 'loading_operations.json');
const SALES_FILE = path.join(BACKUP_DIR, 'sales.json');
const REMOTE_SYNC_FILE = path.join(BACKUP_DIR, 'remote_data.json');

/**
 * Load data from a backup file
 */
function loadBackupFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error loading backup file ${filePath}:`, error);
    return [];
  }
}

/**
 * Save data to a backup file
 */
function saveBackupFile<T>(filePath: string, data: T[]): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error(`Error saving backup file ${filePath}:`, error);
  }
}

/**
 * Merge data from different sources, identifying unique entries by ID
 */
function mergeData<T extends { id: number }>(localData: T[], remoteData: T[]): T[] {
  const allData = [...localData];
  
  // Add remote entries that don't exist locally
  for (const remoteItem of remoteData) {
    if (!allData.some(item => item.id === remoteItem.id)) {
      allData.push(remoteItem);
    }
  }
  
  return allData;
}

/**
 * Backup loading operations
 */
export async function backupLoadingOperations(operations: LoadingOperation[]): Promise<void> {
  // Load existing backup
  const existingBackup = loadBackupFile<LoadingOperation>(LOADING_OPS_FILE);
  
  // Merge with new data
  const mergedData = mergeData(existingBackup, operations);
  
  // Save backup
  saveBackupFile(LOADING_OPS_FILE, mergedData);
}

/**
 * Backup sales data
 */
export async function backupSales(sales: Sale[]): Promise<void> {
  // Load existing backup
  const existingBackup = loadBackupFile<Sale>(SALES_FILE);
  
  // Merge with new data
  const mergedData = mergeData(existingBackup, sales);
  
  // Save backup
  saveBackupFile(SALES_FILE, mergedData);
}

/**
 * Retrieve backed up loading operations
 */
export function getBackedUpLoadingOperations(): LoadingOperation[] {
  return loadBackupFile<LoadingOperation>(LOADING_OPS_FILE);
}

/**
 * Retrieve backed up sales
 */
export function getBackedUpSales(): Sale[] {
  return loadBackupFile<Sale>(SALES_FILE);
}

/**
 * Syncs with the deployed app, if deployedAppUrl is provided
 */
export async function syncWithDeployedApp(deployedAppUrl?: string): Promise<{
  loadingOperations: LoadingOperation[];
  sales: Sale[];
}> {
  if (!deployedAppUrl) {
    return {
      loadingOperations: getBackedUpLoadingOperations(),
      sales: getBackedUpSales()
    };
  }
  
  try {
    // Fetch loading operations from deployed app
    const loadingOpsResponse = await fetch(`${deployedAppUrl}/api/loading-operations?limit=1000`);
    const remoteLoadingOps = await loadingOpsResponse.json();
    
    // Fetch sales from deployed app
    const salesResponse = await fetch(`${deployedAppUrl}/api/sales?limit=1000`);
    const remoteSales = await salesResponse.json();
    
    // Merge with local data
    const localLoadingOps = getBackedUpLoadingOperations();
    const localSales = getBackedUpSales();
    
    const mergedLoadingOps = mergeData(localLoadingOps, remoteLoadingOps);
    const mergedSales = mergeData(localSales, remoteSales);
    
    // Save the merged data
    saveBackupFile(LOADING_OPS_FILE, mergedLoadingOps);
    saveBackupFile(SALES_FILE, mergedSales);
    
    // Save remote data separately
    saveBackupFile(REMOTE_SYNC_FILE, {
      loadingOperations: remoteLoadingOps,
      sales: remoteSales,
      lastSyncTime: new Date().toISOString()
    });
    
    return {
      loadingOperations: mergedLoadingOps,
      sales: mergedSales
    };
  } catch (error) {
    console.error("Error syncing with deployed app:", error);
    return {
      loadingOperations: getBackedUpLoadingOperations(),
      sales: getBackedUpSales()
    };
  }
}

/**
 * Get the timestamp of the last sync with the deployed app
 */
export function getLastSyncTime(): string | null {
  if (!fs.existsSync(REMOTE_SYNC_FILE)) {
    return null;
  }
  
  try {
    const data = fs.readFileSync(REMOTE_SYNC_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return parsed.lastSyncTime || null;
  } catch (error) {
    return null;
  }
}

// Initialize the backup system
export function initializeBackupSystem(): void {
  console.log("Backup system initialized");
}