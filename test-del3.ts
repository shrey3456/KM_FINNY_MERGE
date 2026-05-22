import { db } from './server/db';
import { orders, orderItems } from './shared/schema';
import { eq, inArray } from 'drizzle-orm';

async function main() {
  try {
    const ids = (await db.select({ id: orders.id }).from(orders).where(eq(orders.notes, 'Imported from main order 23.04.2025.csv'))).map(o => o.id);
    console.log("Found ids:", ids.length);
    if (ids.length) {
      // Must delete order items first since there is no CASCADE delete maybe?
      const deletedItems = await db.delete(orderItems).where(inArray(orderItems.orderId, ids)).returning();
      console.log("Deleted items:", deletedItems.length);
      const deletedOrders = await db.delete(orders).where(eq(orders.notes, 'Imported from main order 23.04.2025.csv')).returning();
      console.log("Deleted orders:", deletedOrders.length);
    }
  } catch (err) {
    console.error("Error!!!", err);
  }
  process.exit(0);
}
main();
