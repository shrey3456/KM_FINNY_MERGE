const { Pool } = require('pg');

const conn = process.env.DATABASE_URL;
if (!conn) {
  console.error('ERROR: DATABASE_URL environment variable is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: conn });

(async () => {
  try {
    const table = 'voucher_prefixes';

    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );

    console.log('\n=== Columns ===');
    console.table(cols.rows);

    const constraints = await pool.query(
      `SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) as def
       FROM pg_constraint c
       JOIN pg_class t ON c.conrelid = t.oid
       WHERE t.relname = $1`,
      [table]
    );

    console.log('\n=== Constraints ===');
    console.table(constraints.rows);

    const indexes = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`,
      [table]
    );

    console.log('\n=== Indexes ===');
    console.table(indexes.rows);

    // Show primary key columns specifically via pg_index
    const pk = await pool.query(
      `SELECT a.attname as column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       JOIN pg_class c ON c.oid = i.indrelid
       WHERE c.relname = $1 AND i.indisprimary`,
      [table]
    );
    console.log('\n=== Primary Key Columns ===');
    console.table(pk.rows);

  } catch (err) {
    console.error('ERROR while inspecting voucher_prefixes:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
