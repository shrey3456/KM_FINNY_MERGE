#!/bin/bash

# Source .env file to get DATABASE_URL
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo "Error: DATABASE_URL environment variable is not set"
  exit 1
fi

# Hard-code the values for now since parsing is complex
DB_HOST="ep-sparkling-flower-59343935.us-east-1.postgres.vercel-storage.com"
DB_PORT="5432"
DB_NAME="verceldb"
DB_USER="default"
# Password will be taken from environment variable PGPASSWORD

# Path to SQL dump file
SQL_DUMP="attached_assets/database_backup.sql"

# Drop all tables except for users
echo "Dropping all tables (except users) and constraints..."
PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "
DO \$\$ 
DECLARE
  r RECORD;
BEGIN
  -- Disable triggers temporarily
  SET session_replication_role = 'replica';
  
  -- Drop foreign key constraints first
  FOR r IN (
    SELECT tc.constraint_name, tc.table_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu 
      ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
  ) LOOP
    EXECUTE 'ALTER TABLE ' || quote_ident(r.table_name) || ' DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name) || ' CASCADE';
  END LOOP;
  
  -- Drop all tables except users
  FOR r IN (
    SELECT tablename FROM pg_tables 
    WHERE schemaname = 'public' AND tablename != 'users'
  ) LOOP
    EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
  END LOOP;
  
  -- Re-enable triggers
  SET session_replication_role = 'origin';
END \$\$;
"

# Restore database from SQL dump, exclude commands that create/drop the database itself
echo "Restoring database from SQL dump..."
PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f $SQL_DUMP

echo "Database restoration completed."