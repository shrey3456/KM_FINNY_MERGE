import { pool } from '../db';

// Renaming a User Code. The code is how every record names its user (who scanned, who created, who owns a load ...). Two kinds of place hold it:
//  - columns with a foreign key to users(user_code): they follow the rename by themselves once the key is ON UPDATE CASCADE (ensureUserCodeCascade makes it so);
//  - plain text columns with no key (the "..._by_code", "..._owner_code", "sender_code" ... ones): found by name and updated in the same transaction.
// The signed-in session of the renamed user is updated too, so they stay signed in.

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }> };

// Columns that name a user without a foreign key. Matched by name; only rows holding exactly the old code are changed.
const SOFT_COLUMN_NAME = /(^|_)(user|by|owner|sender|recipient|assigned|scanned|created|updated|edited|voided|deleted|imported|completed|activated|claimed|paused|from|to|managed|picked|removed|transferred)_?(user_)?code$|^user_code$/;

export class UserCodeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// Makes every foreign key that points at users(user_code) follow a rename (ON UPDATE CASCADE). Does nothing when they already do. Returns how many it changed.
export async function ensureUserCodeCascade(db: Db = pool): Promise<number> {
  const { rows } = await db.query(
    `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'users'::regclass AND confupdtype <> 'c'`,
  );
  for (const r of rows) {
    const def = String(r.def).replace(/\s+ON UPDATE (NO ACTION|RESTRICT|SET NULL|SET DEFAULT|CASCADE)/i, '');
    // DROP + ADD in one statement, so the table is never without its key.
    await db.query(`ALTER TABLE ${r.tbl} DROP CONSTRAINT "${r.conname}", ADD CONSTRAINT "${r.conname}" ${def} ON UPDATE CASCADE`);
    console.log(`[Users] ${r.tbl}.${r.conname} now follows a User Code rename (ON UPDATE CASCADE)`);
  }
  return rows.length;
}

async function softColumns(db: Db): Promise<{ tbl: string; col: string }[]> {
  const { rows: fk } = await db.query(
    `SELECT conrelid::regclass::text AS tbl, a.attname AS col
       FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey)
      WHERE k.contype = 'f' AND k.confrelid = 'users'::regclass`,
  );
  const covered = new Set(fk.map((r) => `${r.tbl}.${r.col}`));
  const { rows } = await db.query(
    `SELECT c.table_name AS tbl, c.column_name AS col
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.data_type IN ('text', 'character varying')`,
  );
  return rows
    .filter((r) => SOFT_COLUMN_NAME.test(r.col) && r.tbl !== 'users' && r.tbl !== 'session' && !covered.has(`${r.tbl}.${r.col}`))
    .map((r) => ({ tbl: r.tbl, col: r.col }));
}

// Throws UserCodeError when the new code is empty or already used by another user (checked before anything is saved). Returns the trimmed code.
export async function assertUserCodeFree(newCode: string, oldCode: string, db: Db = pool): Promise<string> {
  const next = newCode.trim();
  if (!next) throw new UserCodeError('The User Code cannot be empty.');
  if (next !== oldCode) {
    const taken = await db.query(`SELECT 1 FROM users WHERE LOWER(user_code) = LOWER($1) LIMIT 1`, [next]);
    if (taken.rows.length > 0) throw new UserCodeError(`The User Code ${next} is already used by another user.`, 409);
  }
  return next;
}

// Renames a user's code everywhere, atomically. `db` lets a test run it inside its own (rolled back) transaction; normally it opens its own.
export async function renameUserCode(oldCode: string, newCode: string, db?: Db): Promise<{ softUpdated: number }> {
  const next = await assertUserCodeFree(newCode, oldCode, db ?? pool);
  if (next === oldCode) return { softUpdated: 0 };

  const ownClient = db ? null : await pool.connect();
  const q: Db = db ?? ownClient!;
  let softUpdated = 0;
  try {
    if (ownClient) await ownClient.query('BEGIN');
    await ensureUserCodeCascade(q);
    const soft = await softColumns(q);
    // The user row first: every foreign-key column follows by cascade.
    const upd = await q.query(`UPDATE users SET user_code = $1 WHERE user_code = $2`, [next, oldCode]);
    if (upd.rowCount === 0) throw new UserCodeError('User not found', 404);
    for (const { tbl, col } of soft) {
      const r = await q.query(`UPDATE "${tbl}" SET "${col}" = $1 WHERE "${col}" = $2`, [next, oldCode]);
      softUpdated += r.rowCount ?? 0;
    }
    // Keep the renamed user signed in: their session names them by user code.
    await q.query(
      `UPDATE session SET sess = jsonb_set(sess::jsonb, '{passport,user}', to_jsonb($1::text))::text WHERE sess::jsonb -> 'passport' ->> 'user' = $2`,
      [next, oldCode],
    );
    if (ownClient) await ownClient.query('COMMIT');
    console.log(`[Users] User Code ${oldCode} renamed to ${next} (${soft.length} plain-text columns checked, ${softUpdated} row(s) updated)`);
  } catch (error) {
    if (ownClient) await ownClient.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    ownClient?.release();
  }
  return { softUpdated };
}
