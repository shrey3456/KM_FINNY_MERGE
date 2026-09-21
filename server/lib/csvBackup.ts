import fs from 'fs';
import path from 'path';
import { pool } from '../db';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CSV backup — the same thing scripts/backup-database-csv.ps1 produces (one <table>.csv per table,
// with a header row), but run from inside the app so Settings can offer it as a button instead of
// needing psql, PowerShell and a terminal on the server.
//
// Written in plain Node on purpose: no psql, no extra package, so it works the same on the Windows
// machine in the office and on a Linux host.
//
// Fidelity is the whole point of a backup, so every column is read as ::text — that hands back
// exactly the text Postgres itself would have written with COPY (its own output function per type),
// instead of whatever the JS driver decides to turn a timestamp or a jsonb into. Values are then
// written with COPY's CSV rules, so scripts/restore-database-csv.ps1 can load them straight back:
//   NULL            → an empty, unquoted field
//   everything else → wrapped in quotes, with any " doubled
// (an empty string therefore comes back as "" and is never confused with NULL).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const CHUNK_ROWS = 5000;

export type CsvBackupTable = { table: string; rows: number; bytes: number };
export type CsvBackupResult = {
  folder: string;
  tables: CsvBackupTable[];
  totalRows: number;
  totalBytes: number;
  startedAt: string;
  finishedAt: string;
};

const csvField = (value: string | null) =>
  value === null || value === undefined ? '' : `"${String(value).replace(/"/g, '""')}"`;

function databaseNameFromUrl(url: string | undefined): string {
  if (!url) return 'database';
  // The password can contain '@' (this app's does), so the host part starts at the LAST '@' —
  // the same hand-parsing the backup/restore PowerShell scripts use for this reason.
  const withoutScheme = url.replace(/^postgres(?:ql)?:\/\//, '');
  const afterCredentials = withoutScheme.slice(withoutScheme.lastIndexOf('@') + 1);
  const name = afterCredentials.split('/')[1]?.split('?')[0]?.trim();
  return name || 'database';
}

function timestampFolderName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
    + `_${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

async function writeTableCsv(table: string, filePath: string): Promise<{ rows: number; bytes: number }> {
  const { rows: columnRows } = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  const columns: string[] = columnRows.map((c: any) => c.column_name);
  if (columns.length === 0) return { rows: 0, bytes: 0 };

  // Read in chunks so a large table (proforma_slip_items runs to hundreds of thousands of rows) is
  // never held in memory all at once. Keyset paging on a numeric id is stable while rows are being
  // written elsewhere; a table without one is small enough to read in a single pass.
  const idColumn = columnRows.find((c: any) =>
    c.column_name === 'id' && ['integer', 'bigint', 'smallint'].includes(c.data_type));
  const selectList = columns.map((c) => `"${c}"::text AS "${c}"`).join(', ');

  const out = fs.createWriteStream(filePath, { encoding: 'utf8' });
  // One error handler for the whole file, not one per write: attaching a listener on every chunk
  // leaks them (Node warns at 11) because the ones added for a write that then succeeds are never
  // taken off again.
  let writeError: Error | null = null;
  out.on('error', (err) => { writeError = err; });
  const write = (chunk: string) =>
    new Promise<void>((resolve, reject) => {
      if (writeError) return reject(writeError);
      if (out.write(chunk)) return resolve();
      out.once('drain', () => (writeError ? reject(writeError) : resolve()));
    });

  let rowCount = 0;
  try {
    await write(`${columns.map((c) => csvField(c)).join(',')}\n`);
    if (idColumn) {
      let lastId: number | null = null;
      for (;;) {
        // src.id, not a bare "id": every column is selected as ::text, so a bare ORDER BY id
        // would bind to that TEXT output column and sort 1, 10, 100, 2 — each chunk would then
        // resume from the wrong place and silently skip rows. Qualifying it forces the real
        // numeric column.
        const { rows }: { rows: any[] } = await pool.query(
          `SELECT ${selectList} FROM "${table}" AS src
           WHERE ($1::bigint IS NULL OR src.id > $1::bigint)
           ORDER BY src.id LIMIT ${CHUNK_ROWS}`,
          [lastId],
        );
        if (rows.length === 0) break;
        await write(rows.map((r: any) => columns.map((c) => csvField(r[c])).join(',')).join('\n') + '\n');
        rowCount += rows.length;
        lastId = Number(rows[rows.length - 1].id);
        if (rows.length < CHUNK_ROWS) break;
      }
    } else {
      const { rows } = await pool.query(`SELECT ${selectList} FROM "${table}"`);
      if (rows.length > 0) {
        await write(rows.map((r: any) => columns.map((c) => csvField(r[c])).join(',')).join('\n') + '\n');
        rowCount = rows.length;
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  if (writeError) throw writeError;

  return { rows: rowCount, bytes: fs.statSync(filePath).size };
}

// Exports every base table in the public schema — nothing is left out, so the folder is a complete
// copy that scripts/restore-database-csv.ps1 can load into an empty database.
export async function runCsvBackup(): Promise<CsvBackupResult> {
  const startedAt = new Date();
  const dbName = databaseNameFromUrl(process.env.DATABASE_URL);
  const folder = path.join(process.cwd(), 'backups', `${dbName}-csv-${timestampFolderName(startedAt)}`);
  fs.mkdirSync(folder, { recursive: true });

  const { rows: tableRows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );

  const tables: CsvBackupTable[] = [];
  for (const row of tableRows as any[]) {
    const table = String(row.table_name);
    const { rows, bytes } = await writeTableCsv(table, path.join(folder, `${table}.csv`));
    tables.push({ table, rows, bytes });
  }

  return {
    folder,
    tables,
    totalRows: tables.reduce((sum, t) => sum + t.rows, 0),
    totalBytes: tables.reduce((sum, t) => sum + t.bytes, 0),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
}
