const { Client } = require('pg');
import 'dotenv/config';

async function bulkCreateSales() {
  console.log('Starting bulk sales creation...');
  
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
    const errorMessages: string[] = [];
    
    // Process each operation in a separate transaction
    for (const op of opsWithoutSales) {
      try {
        // Start transaction for this operation only
        await client.query('BEGIN');
        
        // Get operation items
        const itemsResult = await client.query(`
          SELECT loi.*, p.name, p.barcode, p.category, p.hsn, p.selling_price
          FROM load_operation_items loi
          LEFT JOIN products p ON loi.product_id = p.id
          WHERE loi.loading_operation_id = $1
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
        const dateToUse = op.order_date || (op.created_at ? new Date(op.created_at) : new Date());
        const formattedDate = formatDateToDDMMYYYY(dateToUse);
        
        // Amount needs to be an integer in the database
        const amountAsInt = Math.round(totalAmount);
        
        // Create the sales record using direct SQL to bypass validation that might be causing issues
        const insertResult = await client.query(`
          INSERT INTO sales (order_number, dealer, plant, quantity, amount, notes, status, created_by_id, date, vehicle_number)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
        `, [
          op.reference_number,
          op.party_name || 'Unknown',
          op.plant || 'Unknown',
          op.total_quantity || 0,
          amountAsInt,
          `Auto-generated from Load Operation #${op.id}. Storekeeper: ${op.created_by || 'Unknown'}`,
          'READY≈DESP',
          op.created_by_id || 1,
          formattedDate,
          op.vehicle_number || null
        ]);
        
        const saleId = insertResult.rows[0].id;
        
        // Insert sale items
        for (const item of items) {
          const unitPrice = item.selling_price ? parseFloat(item.selling_price) : 0;
          const quantity = item.quantity || 0;
          
          await client.query(`
            INSERT INTO sale_items (sale_id, sku, barcode, name, quantity, original_quantity, unit_price, total_price, category, hsn)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            saleId,
            item.barcode || null,
            item.barcode || null,
            item.name || 'Unknown Item',
            quantity,
            item.original_quantity || quantity,
            String(unitPrice), // Convert to string for text field
            String(unitPrice * quantity), // Convert to string for text field
            item.category || null,
            item.hsn || null
          ]);
        }
        
        // Create activity record with Postgres generating the ID
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
              dealer: op.party_name || 'Unknown',
              quantity: op.total_quantity || 0,
              amount: totalAmount,
              status: 'READY≈DESP'
            }),
            op.created_by_id || 1,
            op.created_by || 'System'
          ]);
        } catch (activityError: any) {
          // If activity creation fails, log the error but continue with the process
          console.log(`Warning: Could not create activity for sale of order ${op.reference_number}: ${activityError.message}`);
        }
        
        // Commit transaction for this operation
        await client.query('COMMIT');
        
        createdCount++;
        console.log(`Created sale for order ${op.reference_number}`);
      } catch (error: any) {
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
    
    console.log('====== Bulk Sales Creation Summary ======');
    console.log(`Total operations with READY≈DESP status: ${loadingOps.length}`);
    console.log(`Operations without sales entries: ${opsWithoutSales.length}`);
    console.log(`Successfully created: ${createdCount}`);
    console.log(`Failed to create: ${failedCount}`);
    
    if (failedCount > 0) {
      console.log('\nErrors:');
      errorMessages.forEach(msg => console.log(`- ${msg}`));
    }
    
  } catch (error: any) {
    console.error('Error during bulk sales creation:', error.message);
  } finally {
    // Close the client connection
    await client.end();
  }
}

// Helper function to format date to DD/MM/YYYY
function formatDateToDDMMYYYY(date: Date | string): string | null {
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