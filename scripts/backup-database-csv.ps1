<#
.SYNOPSIS
  Exports every table's DATA ONLY (no schema/CREATE TABLE) as one CSV file per table - the
  same result as using pgAdmin's per-table "Export Data..." dialog, just for the whole
  database in one go.

.DESCRIPTION
  Three Notion-related tables are excluded by default:
    - products                       - the product catalog mirrored from Notion
                                        (server/services/notionInventorySync.ts)
    - notion_inventory_sync_config   - which Notion database that sync points atDELETE FROM product_plant_stock WHERE id = 9734;
    
    -- Verify: one row, in_stock = 10608, extra_qty = 192
    SELECT id, barcode, plant, in_stock, extra_qty, product_id, updated_at
    FROM product_plant_stock
    
    - scan_history_notion_config     - which Notion database Scan History's own upload points at
  All three are re-creatable (re-run the sync / re-enter the config) rather than needing a
  restore, and none of them are Drizzle-managed tables (see the note on
  scripts/restore-database-csv.ps1 about why that matters for restoring). Pass -IncludeAll to
  export every table with no exclusions.

  Reads connection details from DATABASE_URL in the repo's .env file, same as the app itself.
  Uses psql's \copy (client-side COPY) rather than server-side COPY, which is what pgAdmin's
  export dialog uses under the hood by default too - it streams through the client connection,
  so it works the same whether the database is on this machine or a remote server, and never
  needs filesystem write access ON the Postgres server itself.

  Output: one CSV per table (with a header row) under
    backups/<database>-csv-<timestamp>/<table>.csv

.EXAMPLE
  # From the repo root:
  .\scripts\backup-database-csv.ps1

.EXAMPLE
  # Include the Notion-related tables too:
  .\scripts\backup-database-csv.ps1 -IncludeAll
#>

param(
    [switch]$IncludeAll
)

$NotionRelatedTables = @("products", "notion_inventory_sync_config", "scan_history_notion_config")

$ErrorActionPreference = "Stop"

# -- Locate the repo root (this script lives in <repo>/scripts) and read .env from there --
$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env"
if (-not (Test-Path $envPath)) {
    throw "Could not find .env at $envPath - expected DATABASE_URL there, same as the app reads."
}

$databaseUrlLine = Get-Content $envPath | Where-Object { $_ -match "^\s*DATABASE_URL\s*=" } | Select-Object -First 1
if (-not $databaseUrlLine) {
    throw "DATABASE_URL not found in $envPath"
}
$databaseUrl = ($databaseUrlLine -split "=", 2)[1].Trim().Trim('"').Trim("'")

# -- Parse postgresql://user:password@host:port/dbname by hand --
# A regex/URI parser would mangle this: the password can itself contain '@' (this one does,
# "Shrey@123"), so the split has to find the LAST '@' - the one separating credentials from
# host - not the first.
if ($databaseUrl -notmatch "^postgres(?:ql)?://(.+)$") {
    throw "DATABASE_URL doesn't look like a postgres connection string."
}
$rest = $Matches[1]
$lastAt = $rest.LastIndexOf("@")
if ($lastAt -lt 0) { throw "DATABASE_URL is missing '@' between credentials and host." }
$credentials = $rest.Substring(0, $lastAt)
$hostPortDb  = $rest.Substring($lastAt + 1)

$firstColon = $credentials.IndexOf(":")
if ($firstColon -lt 0) { throw "DATABASE_URL is missing ':' between user and password." }
$dbUser = $credentials.Substring(0, $firstColon)
$dbPassword = $credentials.Substring($firstColon + 1)

$slashIndex = $hostPortDb.IndexOf("/")
if ($slashIndex -lt 0) { throw "DATABASE_URL is missing the '/<database>' part." }
$hostPort = $hostPortDb.Substring(0, $slashIndex)
$dbName = $hostPortDb.Substring($slashIndex + 1).Split("?")[0]  # drop any ?sslmode=... etc.

$colonIndex = $hostPort.LastIndexOf(":")
if ($colonIndex -lt 0) { throw "DATABASE_URL is missing ':<port>' after the host." }
$dbHost = $hostPort.Substring(0, $colonIndex)
$dbPort = $hostPort.Substring($colonIndex + 1)

Write-Host "Database : $dbName"
Write-Host "Host     : $dbHost`:$dbPort"
Write-Host "User     : $dbUser"
if (-not $IncludeAll) { Write-Host "Excluding: $($NotionRelatedTables -join ', ') (pass -IncludeAll to include them)" }

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
Write-Host "psql     : $psql"

# -- Output location --
$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$outDir = Join-Path $repoRoot "backups\$dbName-csv-$timestamp"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

# -- Talk to Postgres in UTF-8 whatever the console's codepage is. psql otherwise takes its
#    client encoding from the Windows codepage (WIN1252 on a stock Windows Server), and the first
#    character the data holds that WIN1252 has no room for - the app's own Notion statuses carry
#    one, "VEHI=ASSGN" is spelled with U+2248 - kills the export with
#      character with byte sequence 0xe2 0x89 0x88 ... has no equivalent in encoding "WIN1252"
#    The database is UTF-8; this just stops psql transcoding on the way out (and on the way back
#    in, where the same mismatch would silently mangle those characters instead). --
$env:PGCLIENTENCODING = "UTF8"
$env:PGPASSWORD = $dbPassword
try {
    # -- Every base table in the public schema, data only - no views, no Postgres/Drizzle
    #    internals. Table names come straight from the database, so this always covers
    #    whatever tables actually exist, not a hardcoded list that can go stale. --
    $tableListSql = @"
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;
"@
    $tables = & $psql --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName `
        --tuples-only --no-align --command=$tableListSql
    if ($LASTEXITCODE -ne 0) { throw "Failed to list tables (psql exited with code $LASTEXITCODE)." }
    $tables = $tables | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }

    if (-not $IncludeAll) {
        $tables = $tables | Where-Object { $NotionRelatedTables -notcontains $_ }
    }

    Write-Host "Exporting $($tables.Count) tables..."

    # One \copy per table, all in a single psql session (one connection instead of one per
    # table) - built as a script file since \copy is a client meta-command, not SQL, so it
    # only works through psql itself, not a plain query.
    $copyScriptPath = [System.IO.Path]::GetTempFileName()
    try {
        $lines = foreach ($table in $tables) {
            # Forward slashes work fine in Postgres/psql paths on Windows too, and sidestep
            # backslash-escaping headaches inside the generated \copy command text.
            $csvPath = (Join-Path $outDir "$table.csv") -replace '\\', '/'
            "\copy ""$table"" TO '$csvPath' WITH (FORMAT CSV, HEADER)"
        }
        # Windows PowerShell 5.1's `-Encoding UTF8` always writes a byte-order-mark, which psql
        # does NOT strip - on some psql builds it ends up as literal characters before the first
        # command. Writing via .NET directly with BOM explicitly turned off avoids that.
        [System.IO.File]::WriteAllLines($copyScriptPath, $lines, (New-Object System.Text.UTF8Encoding $false))

        & $psql --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName --file=$copyScriptPath
        if ($LASTEXITCODE -ne 0) { throw "psql exited with code $LASTEXITCODE while exporting." }
    } finally {
        Remove-Item $copyScriptPath -ErrorAction SilentlyContinue
    }
} finally {
    # Never leave the password sitting in this shell's environment longer than the export itself.
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\PGCLIENTENCODING -ErrorAction SilentlyContinue
}

$fileCount = (Get-ChildItem $outDir -Filter "*.csv").Count
$totalMb = [math]::Round(((Get-ChildItem $outDir -Filter "*.csv" | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
Write-Host ""
Write-Host "Export complete: $outDir ($fileCount CSV files, $totalMb MB total)"
