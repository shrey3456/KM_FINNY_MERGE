const { Client } = require('pg');
require('dotenv').config();

// Connect to the database
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

// Sample products data taken from backup
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
    createdById: in_stock
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

async function importData() {
  try {
    await client.connect();
    console.log('Connected to database');

    // Clear existing data if any
    await client.query('TRUNCATE products RESTART IDENTITY CASCADE');
    console.log('Cleared existing products data');

    // Insert products
    for (const product of sampleProducts) {
      const insertQuery = `
        INSERT INTO products (
          id, sr_no, barcode, name, category, hsn_code, sap_code, 
          purchased, sold, in_stock, items_per_pallet, selling_price, 
          status, volume_in_cu_ft
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        )
      `;
      
      await client.query(insertQuery, [
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
    }
    console.log(`Imported ${sampleProducts.length} products`);

    // Insert proforma slips
    await client.query('TRUNCATE proforma_slips RESTART IDENTITY CASCADE');
    console.log('Cleared existing proforma_slips data');
    
    for (const slip of sampleProformaSlips) {
      const insertQuery = `
        INSERT INTO proforma_slips (
          id, order_date, order_number, party_name, plant, 
          total_quantity, total_volume, vehicle_number, created_by_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9
        )
      `;
      
      await client.query(insertQuery, [
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
    }
    console.log(`Imported ${sampleProformaSlips.length} proforma slips`);

    // Insert loading operations
    await client.query('TRUNCATE load_operations RESTART IDENTITY CASCADE');
    console.log('Cleared existing load_operations data');
    
    for (const op of sampleLoadingOperations) {
      const insertQuery = `
        INSERT INTO load_operations (
          id, status, reference_number, vehicle_number, 
          created_by_id, order_date
        ) VALUES (
          $1, $2, $3, $4, $5, $6
        )
      `;
      
      await client.query(insertQuery, [
        op.id,
        op.status,
        op.referenceNumber,
        op.vehicleNumber,
        op.createdById,
        op.orderDate
      ]);
    }
    console.log(`Imported ${sampleLoadingOperations.length} loading operations`);

    console.log('Data import completed successfully');
  } catch (err) {
    console.error('Error importing data:', err);
  } finally {
    await client.end();
  }
}

importData();