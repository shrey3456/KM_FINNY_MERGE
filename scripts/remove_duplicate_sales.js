import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Removes duplicate sales entries, keeping only the latest entry for each order number
 */
async function removeDuplicateSales() {
  const client = await pool.connect();
  try {
    // Begin transaction
    await client.query('BEGIN');

    console.log('Finding duplicate sales entries...');
    
    // Get all order numbers with duplicates
    const duplicatesResult = await client.query(`
      SELECT order_number, COUNT(*) as count
      FROM sales
      GROUP BY order_number
      HAVING COUNT(*) > 1
      ORDER BY count DESC
    `);
    
    const duplicates = duplicatesResult.rows;
    console.log(`Found ${duplicates.length} order numbers with duplicate entries`);

    let totalDuplicatesRemoved = 0;
    let totalItemsRemoved = 0;
    
    // Process each order with duplicates
    for (const duplicate of duplicates) {
      const { order_number, count } = duplicate;
      console.log(`Processing order ${order_number} with ${count} duplicates`);
      
      // Get all sales for this order number
      const salesResult = await client.query(`
        SELECT id, created_at, status, notes 
        FROM sales 
        WHERE order_number = $1 
        ORDER BY id DESC
      `, [order_number]);
      
      const sales = salesResult.rows;
      
      // Keep the most recent READY≈DESP entry if available, otherwise keep the most recent entry
      let keepSaleId = null;
      
      // First try to find a READY≈DESP entry
      const readyDespSales = sales.filter(sale => sale.status === 'READY≈DESP');
      if (readyDespSales.length > 0) {
        // Keep the latest READY≈DESP entry
        keepSaleId = readyDespSales[0].id;
      } else {
        // If no READY≈DESP entry, keep the most recent one
        keepSaleId = sales[0].id;
      }
      
      // Get IDs to remove (all except the one to keep)
      const saleIdsToRemove = sales.filter(sale => sale.id !== keepSaleId).map(sale => sale.id);
      
      if (saleIdsToRemove.length > 0) {
        // Count sale items to be removed
        const itemsCountResult = await client.query(`
          SELECT COUNT(*) as count
          FROM sale_items
          WHERE sale_id = ANY($1::int[])
        `, [saleIdsToRemove]);
        
        const itemsToRemove = parseInt(itemsCountResult.rows[0].count);
        
        // Delete related sale items first
        await client.query(`
          DELETE FROM sale_items
          WHERE sale_id = ANY($1::int[])
        `, [saleIdsToRemove]);
        
        // Then delete the duplicate sales
        await client.query(`
          DELETE FROM sales
          WHERE id = ANY($1::int[])
        `, [saleIdsToRemove]);
        
        console.log(`  Removed ${saleIdsToRemove.length} duplicate entries and ${itemsToRemove} related items for order ${order_number}`);
        totalDuplicatesRemoved += saleIdsToRemove.length;
        totalItemsRemoved += itemsToRemove;
      }
    }
    
    // Commit transaction
    await client.query('COMMIT');
    
    console.log(`====== Deduplication Summary ======`);
    console.log(`Orders with duplicates processed: ${duplicates.length}`);
    console.log(`Total duplicate sales removed: ${totalDuplicatesRemoved}`);
    console.log(`Total sale items removed: ${totalItemsRemoved}`);
    console.log(`Deduplication completed successfully!`);
    
  } catch (error) {
    // Rollback transaction in case of error
    await client.query('ROLLBACK');
    console.error('Error removing duplicate sales:', error);
  } finally {
    client.release();
  }
}

// Run the function
removeDuplicateSales().then(() => {
  console.log('Script completed');
  process.exit(0);
}).catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});