import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;

async function countSales() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    
    const totalResult = await client.query('SELECT COUNT(*) FROM sales');
    const readyDespResult = await client.query('SELECT COUNT(*) FROM sales WHERE status = \'READY≈DESP\'');
    
    console.log('Total sales count:', totalResult.rows[0].count);
    console.log('READY≈DESP sales count:', readyDespResult.rows[0].count);
    
    // Check operations without sales
    const operationsQuery = `
      SELECT COUNT(*) FROM load_operations lo
      WHERE lo.status = 'READY≈DESP'
      AND NOT EXISTS (
        SELECT 1 FROM sales s WHERE s.order_number = lo.reference_number
      )
    `;
    const opsWithoutSalesResult = await client.query(operationsQuery);
    console.log('Operations with READY≈DESP status without sales:', opsWithoutSalesResult.rows[0].count);
    
    // Sample recent sales
    const recentSales = await client.query('SELECT id, order_number, date, status FROM sales ORDER BY id DESC LIMIT 5');
    console.log('Recent sales:', recentSales.rows);
    
    // Get sales created in the last 30 minutes
    const recentCreated = await client.query(`
      SELECT COUNT(*) FROM sales 
      WHERE created_at > NOW() - INTERVAL '30 minutes'
    `);
    console.log('Sales created in last 30 minutes:', recentCreated.rows[0].count);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

countSales();