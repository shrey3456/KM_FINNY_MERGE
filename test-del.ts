import { db } from './server/db';
import { orders } from './shared/schema';
import { eq } from 'drizzle-orm';

async function main() {
  try {
    const deletedOrders = await db.delete(orders).where(eq(orders.notes, 'Imported from main order csv.csv')).returning();
    console.log("Deleted count:", deletedOrders.length);
  } catch (err) {
    console.error("Error!!!", err);
  }
  process.exit(0);
}
main();
