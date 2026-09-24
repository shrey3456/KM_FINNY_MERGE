<#
.SYNOPSIS
  Exports ONLY the tables you name as per-table CSVs, in the same format
  scripts/backup-database-csv.ps1 produces - so scripts/restore-database-csv.ps1 loads the folder
  back with no changes at all.

.DESCRIPTION
  The full backup writes every table in the database. This one writes exactly the tables you ask
  for and nothing else, which is what you want when moving a few master tables into another
  database rather than cloning the whole thing.

  The output is byte-for-byte the same shape as the full backup: one <table>.csv per table, with a
  header row, written by psql's \copy. The restore script loads WHATEVER .csv files it finds in a
  folder and reads each one's column list from its own header, so a folder with five files simply
  restores five tables. It already turns foreign-key checks off for the session, runs inside one
  transaction, and resyncs every id counter afterwards - none of which needed changing for this.

  As with the full backup, the TARGET database must already have the schema before a restore:

    $env:DATABASE_URL = "<new database's connection string>"
    npm run db:push

  Two things this deliberately points out rather than hides:
    - Restoring a table without its parents leaves dangling references (proforma_slips.created_by_code
      pointing at people who aren't there). The load still succeeds, because checks are off - the
      data is simply incomplete. Named tables missing an obvious parent are warned about.
    - users holds login credentials. When it's included, that is called out, so the folder isn't
      passed around casually.

.PARAMETER Tables
  The tables to export, comma-separated. Required unless -Preset is used. Checked against the
  database first: a name that doesn't exist stops the whole run, rather than quietly producing an
  incomplete backup.

.PARAMETER Preset
  "Masters" - users, proforma_slips, proforma_slip_items, products, vehicle_info. Users and their
  access (allowed pages / write access / plants all live on the users row), the proforma slips with
  their items, Product Master and Vehicle Master.

.PARAMETER DatabaseUrl
  Connection string to export FROM. Defaults to DATABASE_URL in the repo's .env, same as the full
  backup script.

.EXAMPLE
  .\scripts\backup-database-csv-tables.ps1 -Preset Masters

.EXAMPLE
  .\scripts\backup-database-csv-tables.ps1 -Tables proforma_slips,proforma_slip_items,users,products,vehicle_info

.EXAMPLE
  .\scripts\backup-database-csv-tables.ps1 -Tables vehicle_info -DatabaseUrl "postgresql://postgres:PASSWORD@localhost:5433/OTHER_DB"
#>

param(
    [string[]]$Tables,
    [ValidateSet("Masters")]
    [string]$Preset,
    [string]$DatabaseUrl
)

$ErrorActionPreference = "Stop"

# -- What "Masters" means. Slips and their items travel together on purpose: a slip with no items
#    is not a usable order. --
$PresetTables = @{
    Masters = @("users", "proforma_slips", "proforma_slip_items", "products", "vehicle_info")
}

# -- Parents worth warning about when a child is exported without them. Not exhaustive and not a
#    hard rule - just the ones that make a restored table misleading on its own. --
$ParentOf = @{
    proforma_slip_items = @("proforma_slips")
    proforma_slips      = @("users")
    order_import_items  = @("order_import_sessions")
    unload_import_items = @("unload_import_sessions")
}

if (-not $Tables -and -not $Preset) {
    throw "Name the tables to export: -Tables t1,t2  (or -Preset Masters). Nothing is exported unless you ask for it."
}
if ($Preset) { $Tables = @($PresetTables[$Preset]) + @($Tables) }
$Tables = $Tables | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" } | Select-Object -Unique
if ($Tables.Count -eq 0) { throw "No table names given." }

# -- Locate the repo root (this script lives in <repo>/scripts) and read .env from there --
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DatabaseUrl) {
    $envPath = Join-Path $repoRoot ".env"
    if (-not (Test-Path $envPath)) {
        throw "Could not find .env at $envPath - expected DATABASE_URL there, or pass -DatabaseUrl."
    }
    $databaseUrlLine = Get-Content $envPath | Where-Object { $_ -match "^\s*DATABASE_URL\s*=" } | Select-Object -First 1
    if (-not $databaseUrlLine) { throw "DATABASE_URL not found in $envPath" }
    $DatabaseUrl = ($databaseUrlLine -split "=", 2)[1].Trim().Trim('"').Trim("'")
}

# -- Parse postgresql://user:password@host:port/dbname by hand --
# The password can itself contain '@' (this one does), so the split has to find the LAST '@' - the
# one separating credentials from host - not the first.
if ($DatabaseUrl -notmatch "^postgres(?:ql)?://(.+)$") {
    throw "The connection string doesn't look like a postgres URL."
}
$rest = $Matches[1]
$lastAt = $rest.LastIndexOf("@")
if ($lastAt -lt 0) { throw "Connection string is missing '@' between credentials and host." }
$credentials = $rest.Substring(0, $lastAt)
$hostPortDb  = $rest.Substring($lastAt + 1)

$firstColon = $credentials.IndexOf(":")
if ($firstColon -lt 0) { throw "Connection string is missing ':' between user and password." }
$dbUser = $credentials.Substring(0, $firstColon)
$dbPassword = $credentials.Substring($firstColon + 1)

$slashIndex = $hostPortDb.IndexOf("/")
if ($slashIndex -lt 0) { throw "Connection string is missing the '/<database>' part." }
$hostPort = $hostPortDb.Substring(0, $slashIndex)
$dbName = $hostPortDb.Substring($slashIndex + 1).Split("?")[0]

$colonIndex = $hostPort.LastIndexOf(":")
if ($colonIndex -lt 0) { throw "Connection string is missing ':<port>' after the host." }
$dbHost = $hostPort.Substring(0, $colonIndex)
$dbPort = $hostPort.Substring($colonIndex + 1)

Write-Host "Database : $dbName"
Write-Host "Host     : $dbHost`:$dbPort"
Write-Host "User     : $dbUser"
Write-Host "Tables   : $($Tables -join ', ')"

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
    # -- Every name is checked against the database BEFORE anything is written. A typo must stop
    #    the run, not produce a backup that is quietly missing a table. --
    $existingSql = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;"
    $existing = & $psql --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName `
        --tuples-only --no-align --command=$existingSql
    if ($LASTEXITCODE -ne 0) { throw "Failed to list tables (psql exited with code $LASTEXITCODE)." }
    $existing = $existing | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }

    $missing = $Tables | Where-Object { $existing -notcontains $_ }
    if ($missing) {
        Write-Host ""
        Write-Host "These tables don't exist in $dbName :" -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        Write-Host ""
        Write-Host "Tables that do exist:"
        $existing | ForEach-Object { Write-Host "  $_" }
        throw "Nothing was exported."
    }

    # -- Warnings, not refusals: the export is still valid, it just won't stand alone. --
    foreach ($table in $Tables) {
        if ($ParentOf.ContainsKey($table)) {
            $absentParents = $ParentOf[$table] | Where-Object { $Tables -notcontains $_ }
            foreach ($parent in $absentParents) {
                Write-Host "Note: '$table' references '$parent', which you did not include - those rows will point at data that isn't in the restore." -ForegroundColor Yellow
            }
        }
    }
    if ($Tables -contains "users") {
        Write-Host "Note: 'users' contains login credentials - keep this folder somewhere you control." -ForegroundColor Yellow
    }

    # -- Output location: same naming as the full backup, with -tables- so the two are told apart --
    $timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
    $outDir = Join-Path $repoRoot "backups\$dbName-csv-tables-$timestamp"
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null

    Write-Host ""
    Write-Host "Exporting $($Tables.Count) table(s)..."

    # One \copy per table in a single psql session (one connection instead of one per table) -
    # built as a script file since \copy is a client meta-command, not SQL, so it only works
    # through psql itself, not a plain query.
    $copyScriptPath = [System.IO.Path]::GetTempFileName()
    try {
        $lines = foreach ($table in $Tables) {
            # Forward slashes work fine in Postgres/psql paths on Windows too, and sidestep
            # backslash-escaping headaches inside the generated \copy command text.
            $csvPath = (Join-Path $outDir "$table.csv") -replace '\\', '/'
            "\copy ""$table"" TO '$csvPath' WITH (FORMAT CSV, HEADER)"
        }
        # Windows PowerShell 5.1's `-Encoding UTF8` always writes a byte-order-mark, which psql
        # does NOT strip - on some psql builds it ends up as literal characters before the first
        # command. Writing via .NET directly with BOM explicitly turned off avoids that.
        [System.IO.File]::WriteAllLines($copyScriptPath, $lines, (New-Object System.Text.UTF8Encoding $false))

        & $psql --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName `
            --set=ON_ERROR_STOP=1 --file=$copyScriptPath
        if ($LASTEXITCODE -ne 0) { throw "psql exited with code $LASTEXITCODE while exporting." }
    } finally {
        Remove-Item $copyScriptPath -ErrorAction SilentlyContinue
    }
} finally {
    # Never leave the password sitting in this shell's environment longer than the export itself.
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\PGCLIENTENCODING -ErrorAction SilentlyContinue
}

Write-Host ""
foreach ($table in $Tables) {
    $file = Join-Path $outDir "$table.csv"
    if (Test-Path $file) {
        # -1 for the header row, so this reads as "rows of data".
        $rows = [Math]::Max(0, ((Get-Content $file | Measure-Object -Line).Lines - 1))
        $mb = [math]::Round((Get-Item $file).Length / 1MB, 2)
        Write-Host ("  {0,-24} {1,10} row(s)  {2,8} MB" -f $table, $rows, $mb)
    }
}
$fileCount = (Get-ChildItem $outDir -Filter "*.csv").Count
$totalMb = [math]::Round(((Get-ChildItem $outDir -Filter "*.csv" | Measure-Object -Property Length -Sum).Sum) / 1MB, 2)
Write-Host ""
Write-Host "Export complete: $outDir ($fileCount CSV file(s), $totalMb MB total)"
Write-Host "Restore it with:"
Write-Host "  .\scripts\restore-database-csv.ps1 -CsvFolder `"$outDir`" -DatabaseUrl `"<target database>`""
Write-Host "(run npm run db:push against the target first, so the tables exist)"
