// Import DB client
import pg from 'pg';
const { Client } = pg;
// Load environment variables
import 'dotenv/config';

/**
 * Update existing sales entries with correct data from load_operations and proforma_slips
 * This script fixes "Unknown" dealer and plant values in sales entries
 * by pulling the correct information from the proforma_slips table
 */
async function updateExistingSales() {
  console.log('Starting update of existing sales with data from operations...');
  
  // Connect to the database
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  await client.connect();
  
  try {
    // Get sales with "Unknown" dealer or plant
    const salesResult = await client.query(`
      SELECT s.id, s.order_number, s.dealer, s.plant, s.amount
      FROM sales s
      WHERE s.dealer = 'Unknown' OR s.plant = 'Unknown' OR s.amount = 0
    `);
    
    const salesToUpdate = salesResult.rows;
    console.log(`Found ${salesToUpdate.length} sales with missing or incorrect data`);
    
    if (salesToUpdate.length === 0) {
      console.log('No sales need updating');
      return;
    }
    
    let updatedCount = 0;
    let failedCount = 0;
    const errorMessages = [];
    
    // Process each sale in a separate transaction
    for (const sale of salesToUpdate) {
      try {
        // Start transaction for this sale only
        await client.query('BEGIN');
        
        // Get proforma details to ensure we have party_name and plant
        const proformaResult = await client.query(`
          SELECT * FROM proforma_slips
          WHERE order_number = $1
          ORDER BY created_at DESC
          LIMIT 1
        `, [sale.order_number]);
        
        if (proformaResult.rows.length === 0) {
          console.log(`No proforma found for order ${sale.order_number}, skipping update`);
          await client.query('COMMIT');
          continue;
        }
        
        const proforma = proformaResult.rows[0];
        
        // Get operation details
        const operationResult = await client.query(`
          SELECT lo.*, u.username as created_by 
          FROM load_operations lo
          LEFT JOIN users u ON lo.created_by_id = u.id
          WHERE lo.reference_number = $1
          ORDER BY lo.created_at DESC
          LIMIT 1
        `, [sale.order_number]);
        
        if (operationResult.rows.length === 0) {
          console.log(`No load operation found for order ${sale.order_number}, skipping update`);
          await client.query('COMMIT');
          continue;
        }
        
        const operation = operationResult.rows[0];
        
        // Get operation items for amount calculation
        const itemsResult = await client.query(`
          SELECT loi.*, p.name, p.selling_price
          FROM load_operations_items loi
          LEFT JOIN products p ON loi.product_id = p.id
          WHERE loi.load_operations_id = $1
        `, [operation.id]);
        
        const items = itemsResult.rows;
        
        // Calculate total amount
        let totalAmount = 0;
        for (const item of items) {
          const unitPrice = item.selling_price ? parseFloat(item.selling_price) : 0;
          const quantity = item.quantity || 0;
          totalAmount += unitPrice * quantity;
        }
        
        // Amount needs to be an integer in the database
        const amountAsInt = Math.round(totalAmount);
        
        // Party name and plant from proforma slips
        const partyName = proforma.party_name || sale.dealer;
        const plant = proforma.plant || sale.plant;
        
        // Only update if we have better data
        if (
          (sale.dealer === 'Unknown' && partyName !== 'Unknown') ||
          (sale.plant === 'Unknown' && plant !== 'Unknown') ||
          (sale.amount === 0 && amountAsInt > 0)
        ) {
          // Update the sales record
          await client.query(`
            UPDATE sales
            SET dealer = $1, plant = $2, amount = $3
            WHERE id = $4
          `, [
            partyName,
            plant,
            amountAsInt > 0 ? amountAsInt : sale.amount,
            sale.id
          ]);
          
          // Create activity record for the update
          try {
            await client.query(`
              INSERT INTO activities (page_name, action, entity_type, entity_id, details, user_id, user_name)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              RETURNING id
            `, [
              'Sales',
              'update',
              'sale',
              String(sale.id),
              JSON.stringify({
                orderNumber: sale.order_number,
                oldDealer: sale.dealer,
                newDealer: partyName,
                oldPlant: sale.plant,
                newPlant: plant,
                oldAmount: sale.amount,
                newAmount: amountAsInt > 0 ? amountAsInt : sale.amount
              }),
              1, // Admin user
              'System'
            ]);
          } catch (activityError) {
            console.log(`Warning: Could not create activity for update of sale ${sale.id}: ${activityError.message}`);
          }
          
          updatedCount++;
          console.log(`Updated sale ${sale.id} for order ${sale.order_number}`);
          
          // Also update sale items if amount was recalculated
          if (sale.amount === 0 && amountAsInt > 0 && items.length > 0) {
            // First get existing sale items
            const saleItemsResult = await client.query(`
              SELECT * FROM sale_items WHERE sale_id = $1
            `, [sale.id]);
            
            // If no items, create them from load_operations_items
            if (saleItemsResult.rows.length === 0) {
              for (const item of items) {
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
                  sale.id,
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
              console.log(`Added ${items.length} items to sale ${sale.id}`);
            }
          }
        } else {
          console.log(`No better data found for sale ${sale.id}, skipping update`);
        }
        
        // Commit transaction for this sale
        await client.query('COMMIT');
      } catch (error) {
        // Rollback this sale's transaction
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error(`Error rolling back transaction: ${rollbackError}`);
        }
        
        failedCount++;
        console.error(`Error updating sale for order ${sale.order_number}:`, error.message);
        errorMessages.push(`Order ${sale.order_number}: ${error.message}`);
      }
    }
    
    console.log('====== Sales Update Summary ======');
    console.log(`Total sales with missing data: ${salesToUpdate.length}`);
    console.log(`Successfully updated: ${updatedCount}`);
    console.log(`Failed to update: ${failedCount}`);
    
    if (failedCount > 0) {
      console.log('\nErrors:');
      errorMessages.forEach(msg => console.log(`- ${msg}`));
    }
    
  } catch (error) {
    console.error('Error during sales update:', error.message);
  } finally {
    // Close the client connection
    await client.end();
  }
}

// Run the function
updateExistingSales()
  .then(() => {
    console.log('Sales update completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });