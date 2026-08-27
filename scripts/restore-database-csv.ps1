<#
.SYNOPSIS
  Imports a folder of per-table CSVs (produced by scripts/backup-database-csv.ps1) into a
  database - typically a brand new one.

.DESCRIPTION
  CSV has no schema information in it - only rows. The TARGET database needs its tables
  already created before this can load anything into them. For this app that means running
  the schema push against the new database first:

    $env:DATABASE_URL = "<new database's connection string>"
    npm run db:push

  Once the tables exist, this script loads each CSV back with psql's \copy (the reverse of
  the export), inside a single transaction with foreign-key/trigger checks turned off for the
  session (SET session_replication_role = replica) - the standard Postgres way to bulk-load
  tables in any order without hand-sorting them by foreign-key dependency first. Checks are
  turned back on at the end either way (success or failure) - nothing is left disabled on the
  connection roles this reconnects with later.

  Each \copy names its columns explicitly, read from the CSV's own header row, instead of
  relying on column order matching between the CSV and the target table. This app's migrations
  are mostly incremental ALTER TABLE ADD COLUMN statements (see server/index.ts), so a freshly
  `db:push`-created table can easily end up with a different physical column order than the
  database the CSV came from - a plain positional COPY would then silently write values into
  the wrong columns instead of erroring.

  After the import commits, every SERIAL/IDENTITY column's auto-increment counter is resynced
  to MAX(id) for its table. \copy loads rows WITH their original id values already on them but
  never touches the underlying sequence, so without this step the very first ordinary insert
  the app makes into a restored table (e.g. importing a new Order Import CSV) asks for an id
  that's already taken by a just-restored row and fails with "duplicate key value violates
  unique constraint ..._pkey" - exactly what happened in production before this step existed.

  -DatabaseUrl is REQUIRED, on purpose: this script writes data, and defaulting to whatever
  DATABASE_URL happens to be in .env risks silently importing into your live database instead
  of the new one you meant. You have to name the target explicitly every time.

.PARAMETER CsvFolder
  Path to the folder of .csv files to import (e.g. backups\TEAM-FINNY-csv-2026-08-12_000926).

.PARAMETER DatabaseUrl
  Connection string for the TARGET database, e.g.
  postgresql://postgres:PASSWORD@localhost:5433/NEW_DB_NAME

.PARAMETER Truncate
  Empty each target table (TRUNCATE ... CASCADE) immediately before loading its CSV. Use this
  when re-running an import into a database that already has data in it; leave it off for a
  genuinely empty new database (the default - nothing is deleted unless you pass this).

.EXAMPLE
  .\scripts\restore-database-csv.ps1 -CsvFolder ".\backups\TEAM-FINNY-csv-2026-08-12_000926" -DatabaseUrl "postgresql://postgres:Shrey@123@localhost:5433/TEAM-FINNY-NEW"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$CsvFolder,

    [Parameter(Mandatory = $true)]
    [string]$DatabaseUrl,

    [switch]$Truncate
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $CsvFolder)) {
    throw "CSV folder not found: $CsvFolder"
}
$csvFiles = Get-ChildItem $CsvFolder -Filter "*.csv"
if ($csvFiles.Count -eq 0) {
    throw "No .csv files found in $CsvFolder"
}

# -- Parse postgresql://user:password@host:port/dbname by hand (same logic as the backup
#    scripts) - the password can contain '@', so this finds the LAST '@', not the first. --
if ($DatabaseUrl -notmatch "^postgres(?:ql)?://(.+)$") {
    throw "-DatabaseUrl doesn't look like a postgres connection string."
}
$rest = $Matches[1]
$lastAt = $rest.LastIndexOf("@")
if ($lastAt -lt 0) { throw "-DatabaseUrl is missing '@' between credentials and host." }
$credentials = $rest.Substring(0, $lastAt)
$hostPortDb  = $rest.Substring($lastAt + 1)

$firstColon = $credentials.IndexOf(":")
if ($firstColon -lt 0) { throw "-DatabaseUrl is missing ':' between user and password." }
$dbUser = $credentials.Substring(0, $firstColon)
$dbPassword = $credentials.Substring($firstColon + 1)

$slashIndex = $hostPortDb.IndexOf("/")
if ($slashIndex -lt 0) { throw "-DatabaseUrl is missing the '/<database>' part." }
$hostPort = $hostPortDb.Substring(0, $slashIndex)
$dbName = $hostPortDb.Substring($slashIndex + 1).Split("?")[0]

$colonIndex = $hostPort.LastIndexOf(":")
if ($colonIndex -lt 0) { throw "-DatabaseUrl is missing ':<port>' after the host." }
$dbHost = $hostPort.Substring(0, $colonIndex)
$dbPort = $hostPort.Substring($colonIndex + 1)

Write-Host "Target database : $dbName"
Write-Host "Host            : $dbHost`:$dbPort"
Write-Host "User            : $dbUser"
Write-Host "CSV folder      : $CsvFolder ($($csvFiles.Count) files)"
if ($Truncate) { Write-Host "Mode            : TRUNCATE each table before loading (existing rows in these tables WILL be deleted)" }

# -- Locate psql - PATH first, then the usual Windows install location --
$psql = (Get-Command "psql.exe" -ErrorAction SilentlyContinue).Source
if (-not $psql) {
    $candidate = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($candidate) { $psql = $candidate.FullName }
}
if (-not $psql) {
    throw "psql.exe not found on PATH or under C:\Program Files\PostgreSQL\*\bin. Install PostgreSQL client tools or add psql to PATH."
}

$env:PGPASSWORD = $dbPassword
try {
    $importScriptPath = [System.IO.Path]::GetTempFileName()
    try {
        $lines = @()
        $lines += "BEGIN;"
        # Load tables in any order without hand-sorting by foreign-key dependency - the
        # standard Postgres bulk-load pattern. Restored to DEFAULT at the end (inside the same
        # transaction), so nothing is left disabled once this session ends.
        $lines += "SET session_replication_role = replica;"
        foreach ($file in $csvFiles) {
            $table = $file.BaseName
            $csvPath = $file.FullName -replace '\\', '/'
            if ($Truncate) {
                $lines += "TRUNCATE ""$table"" CASCADE;"
            }
            # Column list read from the CSV's own header and passed explicitly, so COPY maps by
            # NAME instead of position. Without this, a target table whose columns were added
            # over time via ALTER TABLE (this app's normal migration style - see server/index.ts)
            # can easily end up in a different physical column order than the source database
            # had, and a plain positional COPY silently shoves values into the wrong columns (or
            # errors, e.g. a boolean column receiving a date string from a shifted position).
            $header = Get-Content $file.FullName -TotalCount 1
            $columns = $header.Split(",") | ForEach-Object { '"' + $_.Trim().Trim('"') + '"' }
            $columnList = $columns -join ", "
            $lines += "\copy ""$table"" ($columnList) FROM '$csvPath' WITH (FORMAT CSV, HEADER)"
        }
        $lines += "SET session_replication_role = DEFAULT;"
        $lines += "COMMIT;"
        # Windows PowerShell 5.1's `-Encoding UTF8` always writes a byte-order-mark, which psql
        # does NOT strip - it ends up as literal characters before the first statement (BEGIN
        # becomes the unparseable "BOM;BEGIN;"). Writing via .NET directly with BOM explicitly
        # turned off avoids that.
        [System.IO.File]::WriteAllLines($importScriptPath, $lines, (New-Object System.Text.UTF8Encoding $false))

        & $psql --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName `
            --set=ON_ERROR_STOP=1 --file=$importScriptPath
        if ($LASTEXITCODE -ne 0) {
            throw "psql exited with code $LASTEXITCODE - nothing was committed (the whole import ran inside one transaction)."
        }
    } finally {
        Remove-Item $importScriptPath -ErrorAction SilentlyContinue
    }

    # -- Resync every SERIAL/IDENTITY column's auto-increment counter to match the data just
    #    loaded --
    # \copy inserts rows WITH their original id values already on them, but never touches the
    # column's underlying sequence (the counter Postgres hands out for the NEXT plain INSERT
    # that doesn't specify an id). Left alone, that counter stays wherever it was before this
    # restore (usually 1) - so the very first ordinary insert the app makes into a restored
    # table asks for an id that's already taken by a just-restored row, and Postgres rejects it:
    #   duplicate key value violates unique constraint "<table>_pkey"
    # This walks every table/column in the public schema that has an associated sequence and
    # sets it to MAX(id) - exactly what production hit (order_import_items) before this fix
    # existed. Safe to run every time: it only ever moves a counter FORWARD to match reality,
    # never touches a single row of data.
    Write-Host ""
    Write-Host "Resyncing auto-increment sequences to match restored data..."
    $seqScriptPath = [System.IO.Path]::GetTempFileName()
    try {
        $seqSql = @'
DO $$
DECLARE
    rec RECORD;
    fixed_count INT := 0;
BEGIN
    FOR rec IN
        SELECT
            t.relname AS table_name,
            a.attname AS column_name,
            pg_get_serial_sequence('public.' || t.relname, a.attname) AS seq_name
        FROM pg_class t
        JOIN pg_attribute a ON a.attrelid = t.oid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relkind = 'r'
          AND n.nspname = 'public'
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND pg_get_serial_sequence('public.' || t.relname, a.attname) IS NOT NULL
    LOOP
        EXECUTE format(
            'SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM public.%I), 1), true)',
            rec.seq_name, rec.column_name, rec.table_name
        );
        fixed_count := fixed_count + 1;
    END LOOP;
    RAISE NOTICE 'Resynced % sequence(s)', fixed_count;
END $$;
'@
        [System.IO.File]::WriteAllLines($seqScriptPath, @($seqSql), (New-Object System.Text.UTF8Encoding $false))
        & $psql --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName `
            --set=ON_ERROR_STOP=1 --file=$seqScriptPath
        if ($LASTEXITCODE -ne 0) {
            throw "psql exited with code $LASTEXITCODE while resyncing sequences - the data import above already committed successfully, but auto-increment counters may still be stale. Safe to re-run just this script again (or run the sequence-resync SQL by hand)."
        }
    } finally {
        Remove-Item $seqScriptPath -ErrorAction SilentlyContinue
    }
} finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Import complete: $($csvFiles.Count) tables loaded into $dbName, sequences resynced."
