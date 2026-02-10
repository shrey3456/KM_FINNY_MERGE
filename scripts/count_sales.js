const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config();

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
    
    // Check for pagination in the API
    const maxIdResult = await client.query('SELECT MAX(id) FROM sales');
    console.log('Max sales ID:', maxIdResult.rows[0].max);
    
    // Sample recent sales
    const recentSales = await client.query('SELECT id, order_number, date, status FROM sales ORDER BY id DESC LIMIT 5');
    console.log('Recent sales:', recentSales.rows);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

countSales();