import { db } from './server/db';
import { orders } from './shared/schema';

async function main() {
  const result = await db.select({ id: orders.id, notes: orders.notes }).from(orders).limit(5);
  console.log("Current rows in DB:");
  console.log(result);
  process.exit(0);
}
main();
