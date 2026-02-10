// Bulk Create Sales Entries for All Missing Operations with READY≈DESP Status
// This script will find all loading operations with "READY≈DESP" status that don't
// have a corresponding sales entry, and create sales entries for them.

// Using ES modules since the project is configured with "type": "module"
import { pool } from '../server/db.js';
import dotenv from 'dotenv';

dotenv.config();

async function bulkCreateSales() {
  console.log('Starting bulk sales creation...');
  const client = await pool.connect();
  
  try {
    // Start a transaction
    await client.query('BEGIN');
    
    // 1. Find all loading operations with "READY≈DESP" status
    const loadingOpsResult = await client.query(`
      SELECT lo.*, ps.party_name, ps.plant, ps.total_quantity, ps.order_date
      FROM loading_operations lo
      LEFT JOIN proforma_slips ps ON lo.reference_number = ps.order_number
      WHERE lo.status = 'READY≈DESP'
      ORDER BY lo.created_at DESC
    `);
    
    const loadingOps = loadingOpsResult.rows;
    console.log(`Found ${loadingOps.length} loading operations with READY≈DESP status`);
    
    // 2. Find all existing sales to avoid duplication
    const existingSalesResult = await client.query(`
      SELECT order_number FROM sales
    `);
    
    const existingSalesOrderNumbers = new Set(existingSalesResult.rows.map(s => s.order_number));
    console.log(`Found ${existingSalesOrderNumbers.size} existing sales records`);
    
    // 3. Filter for operations that don't have a sales entry
    const opsWithoutSales = loadingOps.filter(op => 
      !existingSalesOrderNumbers.has(op.reference_number)
    );
    
    console.log(`Found ${opsWithoutSales.length} operations without sales entries`);
    
    // 4. Create sales entries for each missing operation
    let createdCount = 0;
    let failedCount = 0;
    let errorMessages = [];
    
    for (const op of opsWithoutSales) {
      try {
        // Get the proforma slip items to calculate total amount
        const itemsResult = await client.query(`
          SELECT psi.*, p.name, p.barcode, p.sr_no, p.price
          FROM proforma_slip_items psi
          LEFT JOIN products p ON psi.product_id = p.id
          WHERE psi.proforma_slip_id = $1
        `, [op.proforma_slip_id]);
        
        const items = itemsResult.rows;
        
        // Calculate total amount
        let totalAmount = 0;
        for (const item of items) {
          const unitPrice = item.price || 0;
          const quantity = item.quantity || 0;
          totalAmount += unitPrice * quantity;
        }
        
        // Format date in DD/MM/YYYY format
        const dateToUse = op.order_date || (op.created_at ? new Date(op.created_at) : new Date());
        const formattedDate = formatDateToDDMMYYYY(dateToUse);
        
        // Create the sales record
        const insertResult = await client.query(`
          INSERT INTO sales (order_number, dealer, plant, quantity, amount, notes, status, created_by_id, date, vehicle_number)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
        `, [
          op.reference_number,
          op.party_name || 'Unknown',
          op.plant || 'Unknown',
          op.total_quantity || 0,
          totalAmount,
          `Auto-generated from Load Operation #${op.id}. Storekeeper: ${op.created_by || 'Unknown'}`,
          'READY≈DESP',
          op.created_by_id || 1,
          formattedDate,
          op.vehicle_number || null
        ]);
        
        const saleId = insertResult.rows[0].id;
        
        // Insert sale items
        for (const item of items) {
          await client.query(`
            INSERT INTO sale_items (sale_id, sku, barcode, name, quantity, original_quantity, unit_price, total_price, category, hsn)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            saleId,
            item.barcode || null,
            item.barcode || null,
            item.name || 'Unknown Item',
            item.quantity || 0,
            item.original_quantity || item.quantity || 0,
            item.price || 0,
            (item.price || 0) * (item.quantity || 0),
            item.category || null,
            item.hsn || null
          ]);
        }
        
        // Create activity record
        await client.query(`
          INSERT INTO activities (page_name, action, entity_type, entity_id, details, user_id, user_name)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          'Sales',
          'create',
          'sale',
          String(saleId),
          JSON.stringify({
            orderNumber: op.reference_number,
            dealer: op.party_name || 'Unknown',
            quantity: op.total_quantity || 0,
            amount: totalAmount,
            status: 'READY≈DESP'
          }),
          op.created_by_id || 1,
          op.created_by || 'System'
        ]);
        
        createdCount++;
        console.log(`Created sale for order ${op.reference_number}`);
      } catch (error) {
        failedCount++;
        console.error(`Error creating sale for order ${op.reference_number}:`, error.message);
        errorMessages.push(`Order ${op.reference_number}: ${error.message}`);
      }
    }
    
    // Commit the transaction
    await client.query('COMMIT');
    
    console.log('====== Bulk Sales Creation Summary ======');
    console.log(`Total operations with READY≈DESP status: ${loadingOps.length}`);
    console.log(`Operations without sales entries: ${opsWithoutSales.length}`);
    console.log(`Successfully created: ${createdCount}`);
    console.log(`Failed to create: ${failedCount}`);
    
    if (failedCount > 0) {
      console.log('\nErrors:');
      errorMessages.forEach(msg => console.log(`- ${msg}`));
    }
    
  } catch (error) {
    // Rollback the transaction in case of error
    await client.query('ROLLBACK');
    console.error('Error during bulk sales creation:', error.message);
  } finally {
    // Release the client back to the pool
    client.release();
  }
}

// Helper function to format date to DD/MM/YYYY
function formatDateToDDMMYYYY(date) {
  if (!date) return null;
  
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  
  return `${day}/${month}/${year}`;
}

// Run the function
bulkCreateSales()
  .then(() => {
    console.log('Bulk sales creation completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });