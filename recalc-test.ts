import pg from 'pg';
import { checkStock, recalculateStock } from './server/lib/stockRecalc';

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:Shrey%40123@localhost:5433/test' });

const before = await checkStock(pool);
console.log('CHECK before:', before.plantRows.length, 'item totals,', before.productRows.length, 'product totals');
for (const r of before.plantRows) console.log('  item   ', r.plant, r.barcode, `now ${r.storedStock} (extra ${r.storedExtra}) -> correct ${r.correctStock} (extra ${r.correctExtra})`, r.storedRows > 1 ? `saved ${r.storedRows}x` : '');
for (const r of before.productRows) console.log('  product', r.barcode, `now ${r.storedTotal} -> correct ${r.correctTotal}`);

// Run the real Apply, but turn its COMMIT into: re-check inside the transaction, then ROLLBACK.
const realConnect = pool.connect.bind(pool);
(pool as any).connect = async () => {
  const client: any = await realConnect();
  const realQuery = client.query.bind(client);
  client.query = async (sql: any, params?: any[]) => {
    if (typeof sql === 'string' && sql.trim() === 'COMMIT') {
      const inside = await checkStock({ query: realQuery });
      console.log('CHECK inside Apply (before rollback):', inside.plantRows.length, 'item totals,', inside.productRows.length, 'product totals');
      return realQuery('ROLLBACK');
    }
    return realQuery(sql, params);
  };
  return client;
};
const result = await recalculateStock(pool);
console.log('APPLY result:', JSON.stringify(result));

(pool as any).connect = realConnect;
const after = await checkStock(pool);
console.log('CHECK after rollback (should equal before):', after.plantRows.length, 'item totals,', after.productRows.length, 'product totals');
await pool.end();
