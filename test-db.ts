import { db } from './server/db';
import { orders } from './shared/schema';
import { ilike } from 'drizzle-orm';

async function main() {
  const result = await db.select({ id: orders.id, notes: orders.notes }).from(orders).where(ilike(orders.notes, 'Imported from%')).limit(10);
  console.log(result);
  process.exit(0);
}
main().catch(console.error);
