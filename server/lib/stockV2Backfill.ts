import { pool } from '../db';
import { findOrCreateLine } from './stockV2';

// One-time (and re-runnable, admin only) conversion of today's stock into Stock (New): one line per
// product_plant_stock row (details from the Product Master), the day-wise book rebuilt from stock_movements,
// and an "Opening carried over" ledger row for whatever the movements don't explain, so each line's Stock
// equals the old live count exactly. Rows whose barcode is not in the Product Master are reported, not made.
//
// Day mapping of the old ledger (IST date of created_at):
//   receive            -> Purchase (extra_qty -> extra purchase)
//   dispatch           -> Sale
//   adjust, loading    -> Sale (a manual load increase is a sale, a decrease takes sale back)
//   transfer in / out  -> Transfer In / Out
//   other adjust       -> ledger row (Adjust / Opening / Void credit)
export type BackfillResult = { lines: number; skipped: Array<{ plant: string; barcode: string; reason: string }>; movements: number; carried: number };

export async function rebuildStockV2(userCode: string | null): Promise<BackfillResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM stock_v2_daily`);
    await client.query(`DELETE FROM stock_v2_ledger`);
    await client.query(`UPDATE stock_v2_lines SET stock_qty = 0`);

    const skipped: BackfillResult['skipped'] = [];
    const lineByKey = new Map<string, number>();
    const keyOf = (plant: string, barcode: string) => `${plant.trim().toLowerCase()}|${barcode.trim().toLowerCase()}`;
    const lineFor = async (plant: string, barcode: string): Promise<number | null> => {
      const k = keyOf(plant, barcode);
      if (lineByKey.has(k)) return lineByKey.get(k)!;
      const line = await findOrCreateLine(client, plant, barcode);
      if (!line) {
        skipped.push({ plant, barcode, reason: 'Barcode is not in the Product Master' });
        return null;
      }
      lineByKey.set(k, line.id);
      return line.id;
    };

    const live = await client.query(`SELECT barcode, plant, in_stock FROM product_plant_stock`);
    const liveQty = new Map<number, number>();
    for (const r of live.rows) {
      const id = await lineFor(r.plant, r.barcode);
      if (id != null) liveQty.set(id, (liveQty.get(id) ?? 0) + Number(r.in_stock ?? 0));
    }

    const mv = await client.query(
      `SELECT m.barcode, m.plant, m.qty, m.extra_qty, m.type, m.source, m.origin, m.reason, m.transfer_dir, m.created_by_code,
              (m.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
              CASE WHEN m.session_id IS NULL THEN NULL
                   WHEN m.source = 'unloading' THEN uis.order_date
                   ELSE ois.order_date END AS session_day
         FROM stock_movements m
         LEFT JOIN order_import_sessions ois ON ois.id = m.session_id AND COALESCE(m.source,'') <> 'unloading'
         LEFT JOIN unload_import_sessions uis ON uis.id = m.session_id AND m.source = 'unloading'
        ORDER BY m.id`,
    );
    let movements = 0;
    const booked = new Map<number, number>();
    const book = (id: number, n: number) => booked.set(id, (booked.get(id) ?? 0) + n);
    for (const m of mv.rows) {
      const id = await lineFor(m.plant, m.barcode);
      if (id == null) continue;
      const qty = Number(m.qty ?? 0);
      // A purchase, and a void / correction of one, sits on its CSV's Order Date (as the old report dates it).
      const sd = String(m.session_day ?? '').slice(0, 10);
      const purchaseDay = /^d{4}-d{2}-d{2}$/.test(sd) ? sd : m.day;
      const extra = Math.abs(Number(m.extra_qty ?? 0));
      let d = { pu: 0, xp: 0, sa: 0, xs: 0, ti: 0, to: 0 };
      let day = m.day;
      if (m.type === 'receive') { d.pu = qty; d.xp = Number(m.extra_qty ?? 0); day = purchaseDay; book(id, qty); }
      else if (m.type === 'adjust' && m.origin === 'void' && m.source !== 'loading') { d.pu = qty; d.xp = Number(m.extra_qty ?? 0); day = purchaseDay; book(id, qty); }
      else if (m.type === 'dispatch') { d.sa = -qty; d.xs = extra; book(id, qty); }
      else if (m.type === 'adjust' && m.source === 'loading') { d.sa = -qty; book(id, qty); }
      else if (m.type === 'transfer') {
        if (m.transfer_dir === 'in') { d.ti = Math.abs(qty); book(id, Math.abs(qty)); }
        else { d.to = Math.abs(qty); book(id, -Math.abs(qty)); }
      } else {
        const kind = m.origin === 'opening' ? 'opening' : m.origin === 'void' ? 'void' : 'adjust';
        await client.query(
          `INSERT INTO stock_v2_ledger (line_id, stock_date, kind, qty, source, origin, reason, created_by_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, m.day, kind, qty, m.source ?? null, m.origin ?? null, m.reason ?? null, m.created_by_code ?? null],
        );
        book(id, qty);
        movements++;
        continue;
      }
      await client.query(
        `INSERT INTO stock_v2_daily (stock_date, line_id, purchase_qty, extra_purchase_qty, sale_qty, extra_sale_qty, transfer_in_qty, transfer_out_qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (stock_date, line_id) DO UPDATE SET
           purchase_qty = stock_v2_daily.purchase_qty + EXCLUDED.purchase_qty,
           extra_purchase_qty = stock_v2_daily.extra_purchase_qty + EXCLUDED.extra_purchase_qty,
           sale_qty = stock_v2_daily.sale_qty + EXCLUDED.sale_qty,
           extra_sale_qty = stock_v2_daily.extra_sale_qty + EXCLUDED.extra_sale_qty,
           transfer_in_qty = stock_v2_daily.transfer_in_qty + EXCLUDED.transfer_in_qty,
           transfer_out_qty = stock_v2_daily.transfer_out_qty + EXCLUDED.transfer_out_qty`,
        [day, id, d.pu, d.xp, d.sa, d.xs, d.ti, d.to],
      );
      movements++;
    }

    // Whatever the old ledger does not explain is carried as an opening row, so Stock matches the old count.
    let carried = 0;
    const ids = new Set<number>([...liveQty.keys(), ...booked.keys()]);
    for (const id of ids) {
      const target = liveQty.get(id) ?? 0;
      const diff = target - (booked.get(id) ?? 0);
      if (diff !== 0) {
        await client.query(
          `INSERT INTO stock_v2_ledger (line_id, stock_date, kind, qty, source, origin, reason, created_by_code)
           VALUES ($1, '2000-01-01', 'opening', $2, 'conversion', 'opening', 'Opening carried over from the old Stock Overview', $3)`,
          [id, diff, userCode],
        );
        carried++;
      }
      await client.query(`UPDATE stock_v2_lines SET stock_qty = $2, updated_at = now() WHERE id = $1`, [id, target]);
    }
    await client.query(`UPDATE stock_v2_config SET last_rebuild_at = now(), last_rebuild_by = $1 WHERE id = 1`, [userCode]);
    await client.query('COMMIT');
    return { lines: lineByKey.size, skipped, movements, carried };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
