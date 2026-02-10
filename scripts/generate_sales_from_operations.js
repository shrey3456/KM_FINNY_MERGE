// Import DB client
import pg from 'pg';
const { Client } = pg;
// Load environment variables
import 'dotenv/config';

/**
 * Generate sales entries based on load_operations and load_operations_items tables
 * This script replaces older versions of bulk_create_sales by properly pulling
 * data from load_operations, load_operations_items, and proforma_slips tables
 */
async function generateSalesFromOperations() {
  console.log('Starting sales generation from load operations...');
  
  // Connect to the database
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  await client.connect();
  
  try {
    // Get loading operations with READY≈DESP status
    const loadingOpsResult = await client.query(`
      SELECT lo.*, u.username as created_by 
      FROM load_operations lo
      LEFT JOIN users u ON lo.created_by_id = u.id
      WHERE lo.status = 'READY≈DESP'
    `);
    
    const loadingOps = loadingOpsResult.rows;
    console.log(`Found ${loadingOps.length} loading operations with READY≈DESP status`);
    
    // Get existing sales
    const salesResult = await client.query(`
      SELECT order_number FROM sales
    `);
    
    const existingSalesOrderNumbers = salesResult.rows.map(sale => sale.order_number);
    console.log(`Found ${existingSalesOrderNumbers.length} existing sales records`);
    
    // Filter out operations that already have sales entries
    const opsWithoutSales = loadingOps.filter(op => 
      !existingSalesOrderNumbers.includes(op.reference_number)
    );
    
    console.log(`Found ${opsWithoutSales.length} operations without sales entries`);
    
    let createdCount = 0;
    let failedCount = 0;
    const errorMessages = [];
    
    // Process each operation in a separate transaction
    for (const op of opsWithoutSales) {
      try {
        // Start transaction for this operation only
        await client.query('BEGIN');
        
        // Get proforma details to ensure we have party_name and plant
        const proformaResult = await client.query(`
          SELECT * FROM proforma_slips
          WHERE order_number = $1
          ORDER BY created_at DESC
          LIMIT 1
        `, [op.reference_number]);
        
        const proforma = proformaResult.rows[0] || {};
        
        // Get operation items
        const itemsResult = await client.query(`
          SELECT loi.*, p.name, p.barcode, p.category, p.hsn_code, p.selling_price
          FROM load_operations_items loi
          LEFT JOIN products p ON loi.product_id = p.id
          WHERE loi.load_operations_id = $1
        `, [op.id]);
        
        const items = itemsResult.rows;
        
        // Calculate total amount
        let totalAmount = 0;
        for (const item of items) {
          const unitPrice = item.selling_price ? parseFloat(item.selling_price) : 0;
          const quantity = item.quantity || 0;
          totalAmount += unitPrice * quantity;
        }
        
        // Format date in DD/MM/YYYY format
        // First try to use order_date from proforma, then from operations, then created_at
        const dateToUse = proforma.order_date || op.order_date || (op.created_at ? new Date(op.created_at) : new Date());
        const formattedDate = formatDateToDDMMYYYY(dateToUse);
        
        // Party name and plant from proforma slips
        const partyName = proforma.party_name || 'Unknown';
        const plant = proforma.plant || 'Unknown';
        
        // Properly calculate the total quantity
        // First from items, then from operation or proforma
        let totalQuantity = 0;
        for (const item of items) {
          totalQuantity += parseInt(item.quantity || 0, 10);
        }
        if (totalQuantity === 0) {
          totalQuantity = op.total_quantity || proforma.total_quantity || 0;
        }
        
        // Amount needs to be an integer in the database
        const amountAsInt = Math.round(totalAmount);
        
        // Use vehicle number from either source
        const vehicleNumber = op.vehicle_number || proforma.vehicle_number || null;
        
        // Create the sales record
        const insertResult = await client.query(`
          INSERT INTO sales (order_number, dealer, plant, quantity, amount, notes, status, created_by_id, date, vehicle_number)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
        `, [
          op.reference_number,
          partyName,
          plant,
          totalQuantity,
          amountAsInt,
          `Generated from Load Operation #${op.id}. Storekeeper: ${op.created_by || 'Unknown'}`,
          'READY≈DESP',
          op.created_by_id || 1,
          formattedDate,
          vehicleNumber
        ]);
        
        const saleId = insertResult.rows[0].id;
        
        // Insert sale items with actual product details
        for (const item of items) {
          // Get item details directly from load_operations_items
          // or fall back to products table if needed
          const itemName = item.item_name || item.name || 'Unknown Item';
          const barcode = item.barcode || null;
          const quantity = parseInt(item.quantity || 0, 10);
          const unitPrice = item.selling_price ? parseFloat(item.selling_price) : 0;
          const totalPrice = unitPrice * quantity;
          const category = item.category || null;
          const hsn = item.hsn_code || null;
          
          await client.query(`
            INSERT INTO sale_items (sale_id, sku, barcode, name, quantity, original_quantity, unit_price, total_price, category, hsn)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            saleId,
            barcode,
            barcode,
            itemName,
            quantity,
            item.original_quantity || quantity,
            String(unitPrice), // Convert to string for text field
            String(totalPrice), // Convert to string for text field
            category,
            hsn
          ]);
        }
        
        // Create activity record
        try {
          await client.query(`
            INSERT INTO activities (page_name, action, entity_type, entity_id, details, user_id, user_name)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
          `, [
            'Sales',
            'create',
            'sale',
            String(saleId),
            JSON.stringify({
              orderNumber: op.reference_number,
              dealer: partyName,
              quantity: totalQuantity,
              amount: totalAmount,
              status: 'READY≈DESP'
            }),
            op.created_by_id || 1,
            op.created_by || 'System'
          ]);
        } catch (activityError) {
          // If activity creation fails, log the error but continue with the process
          console.log(`Warning: Could not create activity for sale of order ${op.reference_number}: ${activityError.message}`);
        }
        
        // Commit transaction for this operation
        await client.query('COMMIT');
        
        createdCount++;
        console.log(`Created sale for order ${op.reference_number} (${partyName})`);
      } catch (error) {
        // Rollback this operation's transaction
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error(`Error rolling back transaction: ${rollbackError}`);
        }
        
        failedCount++;
        console.error(`Error creating sale for order ${op.reference_number}:`, error.message);
        errorMessages.push(`Order ${op.reference_number}: ${error.message}`);
      }
    }
    
    console.log('====== Sales Generation Summary ======');
    console.log(`Total operations with READY≈DESP status: ${loadingOps.length}`);
    console.log(`Operations without sales entries: ${opsWithoutSales.length}`);
    console.log(`Successfully created: ${createdCount}`);
    console.log(`Failed to create: ${failedCount}`);
    
    if (failedCount > 0) {
      console.log('\nErrors:');
      errorMessages.forEach(msg => console.log(`- ${msg}`));
    }
    
  } catch (error) {
    console.error('Error during sales generation:', error.message);
  } finally {
    // Close the client connection
    await client.end();
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
generateSalesFromOperations()
  .then(() => {
    console.log('Sales generation completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });