import { db } from './server/db';
import { orders, orderItems } from './shared/schema';
import { eq } from 'drizzle-orm';

async function main() {
  try {
    const o = await db.insert(orders).values({ 
      orderNumber: 'TEST1234',
      notes: 'Imported from TEST.csv',
      customerName: 'XYZ',
      totalAmount: '123'
    }).returning();
    console.log("Inserted order:", o[0].id);
    await db.insert(orderItems).values({ orderId: o[0].id, name: 'Item', quantity: 1 });
    console.log("Inserted item");
    const d = await db.delete(orders).where(eq(orders.id, o[0].id)).returning();
    console.log("Deleted order:", d.length);
  } catch (err) {
    console.error("Caught error:", err);
  }
  process.exit(0);
}
main();
