import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the extracted data directory
const dataDir = path.join(__dirname, '..', 'extracted_data');

// Create sample data for products
const sampleProducts = [
  {
    id: 1,
    srNo: 'C009',
    barcode: '8906010500870',
    name: '30GM*120 CRUNCHEM CREAM & ONION WAFERS',
    category: 'CRUNCHEM',
    hsnCode: '2005',
    sapCode: '2000',
    purchased: 100,
    sold: 0,
    inStock: 100,
    itemsPerPallet: 20,
    sellingPrice: '300',
    status: 'in stock',
    volumeInCuFt: '3.66'
  },
  {
    id: 2,
    srNo: 'C018',
    barcode: '8906010504311',
    name: '30GM*120 CRUNCHEX CHILLI LEMON WAFERS',
    category: 'CRUNCHEX',
    hsnCode: '2005',
    sapCode: '2000',
    purchased: 100,
    sold: 0,
    inStock: 100,
    itemsPerPallet: 20,
    sellingPrice: '300',
    status: 'in stock',
    volumeInCuFt: '3.83'
  },
  {
    id: 3,
    srNo: 'C029',
    barcode: '8906010500269',
    name: '22GM*144 POP RINGS MASALA',
    category: 'POP RINGS',
    hsnCode: '21069099',
    sapCode: '1046',
    purchased: 120,
    sold: 0,
    inStock: 120,
    itemsPerPallet: 24,
    sellingPrice: '240',
    status: 'in stock',
    volumeInCuFt: '3.85'
  },
  {
    id: 4,
    srNo: 'C001',
    barcode: '8906010500023',
    name: '15GM*192 CRUNCHEM SIMPLY SALTED WAFERS',
    category: 'CRUNCHEM',
    hsnCode: '2005',
    sapCode: '2000',
    purchased: 100,
    sold: 0,
    inStock: 100,
    itemsPerPallet: 20,
    sellingPrice: '300',
    status: 'in stock',
    volumeInCuFt: '3.83'
  },
  {
    id: 5,
    srNo: 'C004',
    barcode: '8906010500481',
    name: '15GM*192 CRUNCHEM TOMATO TWIST WAFERS',
    category: 'CRUNCHEM',
    hsnCode: '2005',
    sapCode: '2000',
    purchased: 100,
    sold: 0,
    inStock: 100,
    itemsPerPallet: 20,
    sellingPrice: '300',
    status: 'in stock',
    volumeInCuFt: '3.83'
  }
];

// Extract real products data
function extractRealProducts() {
  try {
    // Read products data from JSON file
    const productsFilePath = path.join(dataDir, 'products.json');
    
    if (fs.existsSync(productsFilePath)) {
      const productsData = JSON.parse(fs.readFileSync(productsFilePath, 'utf8'));
      
      // Transform into proper format
      return productsData.map((row, index) => {
        const rowData = {};
        
        // Process each column/value from the raw data
        for (const [key, value] of Object.entries(row)) {
          // Convert string values with tabs to actual values
          if (typeof value === 'string' && value.includes('\\t')) {
            const parts = value.split('\\t');
            
            // Map parts to appropriate keys
            rowData.id = parseInt(parts[0], 10);
            rowData.srNo = parts[1] === '\\N' ? null : parts[1];
            rowData.itemNo = parts[2] === '\\N' ? null : parts[2];
            rowData.barcode = parts[3] === '\\N' ? null : parts[3];
            rowData.name = parts[4] === '\\N' ? null : parts[4];
            rowData.category = parts[5] === '\\N' ? null : parts[5];
            rowData.volumeInCuFt = parts[16] === '\\N' ? null : parts[16];
            rowData.hsnCode = parts[6] === '\\N' ? null : parts[6].substring(0, 5);
            rowData.sapCode = parts[6] === '\\N' ? null : parts[6].substring(5);
            rowData.purchased = parts[7] === '\\N' ? 0 : parseInt(parts[7], 10);
            rowData.sold = parts[8] === '\\N' ? 0 : parseInt(parts[8], 10);
            rowData.inStock = parts[9] === '\\N' ? 0 : parseInt(parts[9], 10);
            rowData.itemsPerPallet = parts[10] === '\\N' ? 0 : parseInt(parts[10], 10);
            rowData.sellingPrice = parts[12] === '\\N' ? null : parts[12];
            rowData.status = parts[15] === '\\N' ? 'in stock' : parts[15];
          } else {
            rowData[key] = value === '\\N' ? null : value;
          }
        }
        
        return rowData;
      }).filter(p => p.id && p.name); // Filter out any invalid products
    }
  } catch (err) {
    console.error('Error extracting real products:', err);
  }
  
  return [];
}

// Sample loading operations
const sampleLoadingOperations = [
  {
    id: 1,
    status: 'LOADING',
    referenceNumber: 'LO-2025-001',
    vehicleNumber: 'GJ01AB1234',
    createdById: 1,
    createdAt: new Date().toISOString(),
    orderDate: new Date().toISOString()
  },
  {
    id: 2,
    status: 'READY≈DESP',
    referenceNumber: 'LO-2025-002',
    vehicleNumber: 'GJ05CD5678',
    createdById: 1,
    createdAt: new Date().toISOString(),
    orderDate: new Date().toISOString()
  }
];

// Sample proforma slips
const sampleProformaSlips = [
  {
    id: 1,
    orderDate: new Date().toISOString().split('T')[0],
    orderNumber: 'PF-2025-001',
    partyName: 'Krishna Enterprises',
    plant: 'Plant A',
    totalQuantity: 50,
    totalVolume: '192.5',
    vehicleNumber: 'GJ01AB1234',
    createdById: 1,
    createdAt: new Date().toISOString()
  },
  {
    id: 2,
    orderDate: new Date().toISOString().split('T')[0],
    orderNumber: 'PF-2025-002',
    partyName: 'Radhey Trade',
    plant: 'Plant B',
    totalQuantity: 75,
    totalVolume: '288.75',
    vehicleNumber: 'GJ05CD5678',
    createdById: 1,
    createdAt: new Date().toISOString()
  }
];

// Sample proforma items
const sampleProformaItems = [
  {
    id: 1,
    proformaSlipId: 1,
    productId: 1,
    quantity: 20,
    originalQuantity: 20,
    loadedQuantity: 0,
    loaded: false,
    srNo: 'C009',
    barcode: '8906010500870',
    itemName: '30GM*120 CRUNCHEM CREAM & ONION WAFERS',
    createdAt: new Date().toISOString()
  },
  {
    id: 2,
    proformaSlipId: 1,
    productId: 2,
    quantity: 30,
    originalQuantity: 30,
    loadedQuantity: 0,
    loaded: false,
    srNo: 'C018',
    barcode: '8906010504311',
    itemName: '30GM*120 CRUNCHEX CHILLI LEMON WAFERS',
    createdAt: new Date().toISOString()
  },
  {
    id: 3,
    proformaSlipId: 2,
    productId: 3,
    quantity: 40,
    originalQuantity: 40,
    loadedQuantity: 0,
    loaded: false,
    srNo: 'C029',
    barcode: '8906010500269',
    itemName: '22GM*144 POP RINGS MASALA',
    createdAt: new Date().toISOString()
  },
  {
    id: 4,
    proformaSlipId: 2,
    productId: 4,
    quantity: 35,
    originalQuantity: 35,
    loadedQuantity: 0,
    loaded: false,
    srNo: 'C001',
    barcode: '8906010500023',
    itemName: '15GM*192 CRUNCHEM SIMPLY SALTED WAFERS',
    createdAt: new Date().toISOString()
  }
];

// Loading operations items
const sampleLoadingItems = [
  {
    id: 1,
    loadOperationsId: 1,
    productId: 1,
    quantity: 20,
    originalQuantity: 20,
    loadedQuantity: 0,
    loaded: false,
    srNo: 'C009',
    barcode: '8906010500870',
    itemName: '30GM*120 CRUNCHEM CREAM & ONION WAFERS',
    srNoDisplay: '1',
    createdAt: new Date().toISOString()
  },
  {
    id: 2,
    loadOperationsId: 1,
    productId: 2,
    quantity: 30,
    originalQuantity: 30,
    loadedQuantity: 0,
    loaded: false,
    srNo: 'C018',
    barcode: '8906010504311',
    itemName: '30GM*120 CRUNCHEX CHILLI LEMON WAFERS',
    srNoDisplay: '2',
    createdAt: new Date().toISOString()
  },
  {
    id: 3,
    loadOperationsId: 2,
    productId: 3,
    quantity: 25,
    originalQuantity: 25,
    loadedQuantity: 25,
    loaded: true,
    srNo: 'C029',
    barcode: '8906010500269',
    itemName: '22GM*144 POP RINGS MASALA',
    srNoDisplay: '1',
    createdAt: new Date().toISOString()
  },
  {
    id: 4,
    loadOperationsId: 2,
    productId: 4,
    quantity: 50,
    originalQuantity: 50,
    loadedQuantity: 50,
    loaded: true,
    srNo: 'C001',
    barcode: '8906010500023',
    itemName: '15GM*192 CRUNCHEM SIMPLY SALTED WAFERS',
    srNoDisplay: '2',
    createdAt: new Date().toISOString()
  }
];

async function importSpecificTables() {
  // Create a PostgreSQL client
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // Choose between sample data or extracted real data
    const productsToImport = extractRealProducts().length > 0 
      ? extractRealProducts().slice(0, 100) // Take first 100 products
      : sampleProducts;
      
    console.log(`Will import ${productsToImport.length} products`);
    
    // Clear existing data
    console.log('Clearing existing data from tables...');
    await client.query('TRUNCATE TABLE load_operations_items CASCADE');
    await client.query('TRUNCATE TABLE proforma_slip_items CASCADE');
    await client.query('TRUNCATE TABLE load_operations CASCADE');
    await client.query('TRUNCATE TABLE proforma_slips CASCADE');
    await client.query('TRUNCATE TABLE products CASCADE');
    
    // Import products
    console.log('Importing products...');
    for (const product of productsToImport) {
      try {
        await client.query(`
          INSERT INTO products (
            id, sr_no, barcode, name, category, hsn_code, sap_code, 
            purchased, sold, in_stock, items_per_pallet, selling_price, 
            status, volume_in_cu_ft, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
          ON CONFLICT (id) DO NOTHING
        `, [
          product.id,
          product.srNo,
          product.barcode,
          product.name,
          product.category,
          product.hsnCode,
          product.sapCode,
          product.purchased,
          product.sold,
          product.inStock,
          product.itemsPerPallet,
          product.sellingPrice,
          product.status,
          product.volumeInCuFt
        ]);
      } catch (err) {
        console.error(`Error inserting product ${product.name}:`, err.message);
      }
    }
    console.log(`Inserted ${productsToImport.length} products`);
    
    // Import proforma slips
    console.log('Importing proforma slips...');
    for (const slip of sampleProformaSlips) {
      try {
        await client.query(`
          INSERT INTO proforma_slips (
            id, order_date, order_number, party_name, plant, 
            total_quantity, total_volume, vehicle_number, created_by_id, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (id) DO NOTHING
        `, [
          slip.id,
          slip.orderDate,
          slip.orderNumber,
          slip.partyName,
          slip.plant,
          slip.totalQuantity,
          slip.totalVolume,
          slip.vehicleNumber,
          slip.createdById,
          slip.createdAt
        ]);
      } catch (err) {
        console.error(`Error inserting proforma slip ${slip.orderNumber}:`, err.message);
      }
    }
    console.log(`Inserted ${sampleProformaSlips.length} proforma slips`);
    
    // Import loading operations
    console.log('Importing loading operations...');
    for (const op of sampleLoadingOperations) {
      try {
        await client.query(`
          INSERT INTO load_operations (
            id, status, reference_number, vehicle_number, 
            created_by_id, created_at, order_date
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO NOTHING
        `, [
          op.id,
          op.status,
          op.referenceNumber,
          op.vehicleNumber,
          op.createdById,
          op.createdAt,
          op.orderDate
        ]);
      } catch (err) {
        console.error(`Error inserting loading operation ${op.referenceNumber}:`, err.message);
      }
    }
    console.log(`Inserted ${sampleLoadingOperations.length} loading operations`);
    
    // Import proforma items
    console.log('Importing proforma items...');
    for (const item of sampleProformaItems) {
      try {
        await client.query(`
          INSERT INTO proforma_slip_items (
            id, proforma_slip_id, product_id, quantity, 
            original_quantity, loaded_quantity, loaded,
            created_at, sr_no, barcode, item_name
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (id) DO NOTHING
        `, [
          item.id,
          item.proformaSlipId,
          item.productId,
          item.quantity,
          item.originalQuantity,
          item.loadedQuantity,
          item.loaded,
          item.createdAt,
          item.srNo,
          item.barcode,
          item.itemName
        ]);
      } catch (err) {
        console.error(`Error inserting proforma item for product ${item.itemName}:`, err.message);
      }
    }
    console.log(`Inserted ${sampleProformaItems.length} proforma items`);
    
    // Import loading items
    console.log('Importing loading items...');
    for (const item of sampleLoadingItems) {
      try {
        await client.query(`
          INSERT INTO load_operations_items (
            id, load_operations_id, product_id, quantity, 
            original_quantity, loaded_quantity, loaded,
            created_at, sr_no, barcode, item_name, sr_no_display
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO NOTHING
        `, [
          item.id,
          item.loadOperationsId,
          item.productId,
          item.quantity,
          item.originalQuantity,
          item.loadedQuantity,
          item.loaded,
          item.createdAt,
          item.srNo,
          item.barcode,
          item.itemName,
          item.srNoDisplay
        ]);
      } catch (err) {
        console.error(`Error inserting loading item for product ${item.itemName}:`, err.message);
      }
    }
    console.log(`Inserted ${sampleLoadingItems.length} loading operation items`);
    
    console.log('Data import completed successfully');
  } catch (err) {
    console.error('Error importing data:', err);
  } finally {
    await client.end();
  }
}

// Run the function
importSpecificTables();