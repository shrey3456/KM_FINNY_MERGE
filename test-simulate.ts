import { db } from './server/db';
import { orders, orderItems } from './shared/schema';
import { eq } from 'drizzle-orm';

async function main() {
  try {
    const o = await db.insert(orders).values({ 
      orderNumber: 'TEST-DEL-1',
      dealer: 'DEALER-X',
      notes: 'Imported from TEST-FILE.csv',
      customerName: 'XYZ',
      totalAmount: '123'
    }).returning();
    const orderId = o[0].id;
    console.log("Inserted order:", orderId);
    
    await db.insert(orderItems).values({ orderId: orderId, name: 'Item', quantity: 1 });
    console.log("Inserted item");
    
    // Simulate what the API route does
    const deletedOrders = await db
        .delete(orders)
        .where(eq(orders.notes, 'Imported from TEST-FILE.csv'))
        .returning();
        
    console.log("Deleted count:", deletedOrders.length);
  } catch (err: any) {
    console.error("Caught error:", err.message);
  }
  process.exit(0);
}
main();
