// Import sample data script
import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

// Sample products data
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
    sold: 22,
    inStock: 78,
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
    sold: 24,
    inStock: 76,
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
    sold: 20,
    inStock: 100,
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
    sold: 21,
    inStock: 79,
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
    sold: 22,
    inStock: 78,
    itemsPerPallet: 20,
    sellingPrice: '300',
    status: 'in stock',
    volumeInCuFt: '3.83'
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
    createdById: 1
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
    createdById: 1
  }
];

// Sample loading operations
const sampleLoadingOperations = [
  {
    id: 1,
    status: 'LOADING',
    referenceNumber: 'LO-2025-001',
    vehicleNumber: 'GJ01AB1234',
    createdById: 1,
    orderDate: new Date().toISOString()
  },
  {
    id: 2,
    status: 'READY≈DESP',
    referenceNumber: 'LO-2025-002',
    vehicleNumber: 'GJ05CD5678',
    createdById: 1,
    orderDate: new Date().toISOString()
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
    itemName: '30GM*120 CRUNCHEM CREAM & ONION WAFERS'
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
    itemName: '30GM*120 CRUNCHEX CHILLI LEMON WAFERS'
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
    itemName: '22GM*144 POP RINGS MASALA'
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
    itemName: '15GM*192 CRUNCHEM SIMPLY SALTED WAFERS'
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
    srNoDisplay: '1'
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
    srNoDisplay: '2'
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
    srNoDisplay: '1'
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
    srNoDisplay: '2'
  }
];

// Function to insert products
async function insertProducts(client) {
  for (const product of sampleProducts) {
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
  console.log(`Inserted ${sampleProducts.length} products`);
}

// Function to insert proforma slips
async function insertProformaSlips(client) {
  for (const slip of sampleProformaSlips) {
    try {
      await client.query(`
        INSERT INTO proforma_slips (
          id, order_date, order_number, party_name, plant, 
          total_quantity, total_volume, vehicle_number, created_by_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
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
        slip.createdById
      ]);
    } catch (err) {
      console.error(`Error inserting proforma slip ${slip.orderNumber}:`, err.message);
    }
  }
  console.log(`Inserted ${sampleProformaSlips.length} proforma slips`);
}

// Function to insert loading operations
async function insertLoadingOperations(client) {
  for (const op of sampleLoadingOperations) {
    try {
      await client.query(`
        INSERT INTO load_operations (
          id, status, reference_number, vehicle_number, 
          created_by_id, created_at, order_date
        ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
        ON CONFLICT (id) DO NOTHING
      `, [
        op.id,
        op.status,
        op.referenceNumber,
        op.vehicleNumber,
        op.createdById,
        op.orderDate
      ]);
    } catch (err) {
      console.error(`Error inserting loading operation ${op.referenceNumber}:`, err.message);
    }
  }
  console.log(`Inserted ${sampleLoadingOperations.length} loading operations`);
}

// Function to insert proforma items
async function insertProformaItems(client) {
  for (const item of sampleProformaItems) {
    try {
      await client.query(`
        INSERT INTO proforma_slip_items (
          id, proforma_slip_id, product_id, quantity, 
          original_quantity, loaded_quantity, loaded,
          created_at, sr_no, barcode, item_name
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10)
        ON CONFLICT (id) DO NOTHING
      `, [
        item.id,
        item.proformaSlipId,
        item.productId,
        item.quantity,
        item.originalQuantity,
        item.loadedQuantity,
        item.loaded,
        item.srNo,
        item.barcode,
        item.itemName
      ]);
    } catch (err) {
      console.error(`Error inserting proforma item for product ${item.itemName}:`, err.message);
    }
  }
  console.log(`Inserted ${sampleProformaItems.length} proforma items`);
}

// Function to insert loading operation items
async function insertLoadingItems(client) {
  for (const item of sampleLoadingItems) {
    try {
      await client.query(`
        INSERT INTO load_operations_items (
          id, load_operations_id, product_id, quantity, 
          original_quantity, loaded_quantity, loaded,
          created_at, sr_no, barcode, item_name, sr_no_display
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11)
        ON CONFLICT (id) DO NOTHING
      `, [
        item.id,
        item.loadOperationsId,
        item.productId,
        item.quantity,
        item.originalQuantity,
        item.loadedQuantity,
        item.loaded,
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
}

// Main function
async function importSampleData() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Begin transaction
    await client.query('BEGIN');

    console.log('Importing sample products...');
    await insertProducts(client);

    console.log('Importing sample proforma slips...');
    await insertProformaSlips(client);

    console.log('Importing sample loading operations...');
    await insertLoadingOperations(client);

    console.log('Importing sample proforma items...');
    await insertProformaItems(client);

    console.log('Importing sample loading items...');
    await insertLoadingItems(client);

    // Commit transaction
    await client.query('COMMIT');
    console.log('Sample data import completed successfully');

  } catch (err) {
    console.error('Error importing sample data:', err);
    // Rollback transaction on error
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
}

// Run the script
importSampleData();