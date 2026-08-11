<#
.SYNOPSIS
  Backs up the whole PostgreSQL database (schema + data), except the "products" table.

.DESCRIPTION
  "products" is excluded on purpose: it's the product catalog mirrored from Notion
  (server/services/notionInventorySync.ts) - re-creatable by re-running that sync, so it's
  left out to keep the backup smaller/faster. Every other table (orders, scan history, stock,
  users, plants, proforma slips, etc.) is included in full.

  Reads connection details from DATABASE_URL in the repo's .env file (same one the app itself
  uses), so there's nothing to configure separately. The password is passed via the PGPASSWORD
  environment variable for this process only - never on the command line - since it can contain
  characters (this DB's does) that would otherwise need careful escaping.

  Output is a single pg_dump "custom format" file (compressed, supports selective restore via
  pg_restore) at backups/<database>-backup-<timestamp>.dump. backups/ is gitignored - these
  files hold real business data and must never be committed.

.EXAMPLE
  # From the repo root:
  .\scripts\backup-database.ps1

.NOTES
  Restore into an existing (possibly empty) database with:
    pg_restore -h <host> -p <port> -U <user> -d <dbname> --no-owner --no-privileges --clean --if-exists <path-to-.dump>
  (pg_restore will prompt for a password unless PGPASSWORD is set the same way.)
#>

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
Write-Host "Excluding: public.products"

# -- Locate pg_dump - PATH first, then the usual Windows install location --
$pgDump = (Get-Command "pg_dump.exe" -ErrorAction SilentlyContinue).Source
if (-not $pgDump) {
    $candidate = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($candidate) { $pgDump = $candidate.FullName }
}
if (-not $pgDump) {
    throw "pg_dump.exe not found on PATH or under C:\Program Files\PostgreSQL\*\bin. Install PostgreSQL client tools or add pg_dump to PATH."
}
Write-Host "pg_dump  : $pgDump"

# -- Output location --
$backupDir = Join-Path $repoRoot "backups"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$outFile = Join-Path $backupDir "$dbName-backup-$timestamp.dump"

# -- Run pg_dump - custom format (-Fc): compressed, and pg_restore can pull out individual
#    tables later instead of only being able to replay the whole file. --no-owner/--no-privileges
#    so a restore doesn't fail on a role that doesn't exist in whatever environment it lands in. --
$env:PGPASSWORD = $dbPassword
try {
    & $pgDump `
        --host=$dbHost `
        --port=$dbPort `
        --username=$dbUser `
        --dbname=$dbName `
        --format=custom `
        --no-owner `
        --no-privileges `
        --exclude-table=public.products `
        --file=$outFile
    if ($LASTEXITCODE -ne 0) {
        throw "pg_dump exited with code $LASTEXITCODE"
    }
} finally {
    # Never leave the password sitting in this shell's environment longer than the dump itself.
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

$sizeMb = [math]::Round((Get-Item $outFile).Length / 1MB, 1)
Write-Host ""
Write-Host "Backup complete: $outFile ($sizeMb MB)"
Write-Host "Restore with:"
Write-Host "  pg_restore -h $dbHost -p $dbPort -U $dbUser -d <target-db> --no-owner --no-privileges --clean --if-exists `"$outFile`""
