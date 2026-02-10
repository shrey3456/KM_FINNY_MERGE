// Import DB client
import pg from 'pg';
const { Client } = pg;
// Load environment variables
import 'dotenv/config';

async function finalCreateSales() {
  console.log('Starting final sales creation...');
  
  // Connect to the database
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  await client.connect();
  
  try {
    // Get loading operations with READY≈DESP status that don't have sales yet
    const loadingOpsResult = await client.query(`
      SELECT lo.*, u.username as created_by 
      FROM load_operations lo
      LEFT JOIN users u ON lo.created_by_id = u.id
      WHERE lo.status = 'READY≈DESP'
      AND NOT EXISTS (
        SELECT 1 FROM sales s WHERE s.order_number = lo.reference_number
      )
    `);
    
    const loadingOps = loadingOpsResult.rows;
    console.log(`Found ${loadingOps.length} operations without sales entries`);
    
    if (loadingOps.length === 0) {
      console.log('No operations need sales records created. All operations already have sales.');
      return;
    }
    
    // Process in batches of 10 operations
    const batchSize = 10;
    const totalBatches = Math.ceil(loadingOps.length / batchSize);
    
    let createdCount = 0;
    let failedCount = 0;
    const errorMessages = [];
    
    // Process in batches
    for (let i = 0; i < totalBatches; i++) {
      const startIdx = i * batchSize;
      const endIdx = Math.min((i + 1) * batchSize, loadingOps.length);
      const batch = loadingOps.slice(startIdx, endIdx);
      
      console.log(`\nProcessing batch ${i + 1} of ${totalBatches} (operations ${startIdx + 1} to ${endIdx})`);
      
      // Process each operation in the batch
      for (const op of batch) {
        try {
          // Start transaction
          await client.query('BEGIN');
          
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
          const dateToUse = op.order_date || (op.created_at ? new Date(op.created_at) : new Date());
          const formattedDate = formatDateToDDMMYYYY(dateToUse);
          
          // Amount needs to be an integer in the database
          const amountAsInt = Math.round(totalAmount);
          
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
              item.hsn_code || null
            ]);
          }
          
          // Commit transaction
          await client.query('COMMIT');
          
          createdCount++;
          console.log(`Created sale for order ${op.reference_number}`);
        } catch (error) {
          // Rollback transaction
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
      
      console.log(`Completed batch ${i + 1} of ${totalBatches}`);
      
      // Give the database a small breather between batches
      if (i < totalBatches - 1) {
        console.log('Pausing 2 seconds before next batch...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    console.log('\n====== Final Sales Creation Summary ======');
    console.log(`Successfully created: ${createdCount}`);
    console.log(`Failed to create: ${failedCount}`);
    
    if (failedCount > 0) {
      console.log('\nErrors:');
      errorMessages.forEach(msg => console.log(`- ${msg}`));
    }
    
  } catch (error) {
    console.error('Error during final sales creation:', error.message);
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
finalCreateSales()
  .then(() => {
    console.log('Final sales creation completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });