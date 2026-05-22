import { db } from './server/db';
import { orders } from './shared/schema';
import { sql } from 'drizzle-orm';

async function main() {
  const result = await db.execute(sql`DELETE FROM orders WHERE notes LIKE 'Imported from %' RETURNING id`);
  console.log("Deleted count direct sql:", result);
  process.exit(0);
}
main().catch(err => {
  console.error("Manual delete error:", err);
  process.exit(1);
});
