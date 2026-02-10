# KM Finny - Database Migration Guide

This guide will help you export the current database from Replit and import it into your local PostgreSQL setup.

## Method 1: Direct Database Export (Recommended)

### Step 1: Export Database from Replit

I've created a database export file for you. The export includes:
- All table structures
- All data (users, products, operations, etc.)
- Proper cleanup commands
- No ownership/privilege conflicts

### Step 2: Setup Local PostgreSQL

1. **Install PostgreSQL locally:**
   ```bash
   # macOS (using Homebrew)
   brew install postgresql
   brew services start postgresql
   
   # Ubuntu/Debian
   sudo apt update
   sudo apt install postgresql postgresql-contrib
   sudo systemctl start postgresql
   
   # Windows
   # Download from https://www.postgresql.org/download/windows/
   ```

2. **Create database and user:**
   ```bash
   # Connect as postgres user
   sudo -u postgres psql
   
   # Or on macOS/Windows
   psql -U postgres
   ```
   
   ```sql
   -- Create database
   CREATE DATABASE km_finny;
   
   -- Create user
   CREATE USER km_finny_user WITH PASSWORD 'your_secure_password';
   
   -- Grant permissions
   GRANT ALL PRIVILEGES ON DATABASE km_finny TO km_finny_user;
   ALTER USER km_finny_user CREATEDB;
   
   -- Exit
   \q
   ```

### Step 3: Import Database

1. **Download the export file** from this Replit project
2. **Import into your local database:**
   ```bash
   psql -U km_finny_user -d km_finny -f database_export_YYYYMMDD_HHMMSS.sql
   ```

### Step 4: Configure Local Environment

Create `.env` file in your local project:
```env
# Database Configuration
DATABASE_URL=postgresql://km_finny_user:your_secure_password@localhost:5432/km_finny

# Session Configuration  
SESSION_SECRET=your-super-secret-session-key-minimum-32-characters-long

# Development Settings
NODE_ENV=development
PORT=5000
```

## Method 2: Using Docker for Local PostgreSQL

### Step 1: Start PostgreSQL Container
```bash
docker run --name km-finny-postgres \
  -e POSTGRES_DB=km_finny \
  -e POSTGRES_USER=km_finny_user \
  -e POSTGRES_PASSWORD=secure_password \
  -p 5432:5432 \
  -v km_finny_data:/var/lib/postgresql/data \
  -d postgres:15
```

### Step 2: Import Database
```bash
# Copy export file to container
docker cp database_export_YYYYMMDD_HHMMSS.sql km-finny-postgres:/tmp/

# Import the database
docker exec -i km-finny-postgres psql -U km_finny_user -d km_finny -f /tmp/database_export_YYYYMMDD_HHMMSS.sql
```

### Step 3: Configure Environment
```env
DATABASE_URL=postgresql://km_finny_user:secure_password@localhost:5432/km_finny
SESSION_SECRET=your-super-secret-session-key-minimum-32-characters-long
NODE_ENV=development
PORT=5000
```

## Method 3: Manual Data Export (Alternative)

If you prefer to export specific data:

### Export Users
```bash
psql $DATABASE_URL -c "COPY users TO STDOUT WITH CSV HEADER" > users_export.csv
```

### Export Products  
```bash
psql $DATABASE_URL -c "COPY products TO STDOUT WITH CSV HEADER" > products_export.csv
```

### Export Load Operations
```bash
psql $DATABASE_URL -c "COPY load_operations TO STDOUT WITH CSV HEADER" > load_operations_export.csv
psql $DATABASE_URL -c "COPY load_operations_items TO STDOUT WITH CSV HEADER" > load_operations_items_export.csv
```

### Export Proforma Slips
```bash
psql $DATABASE_URL -c "COPY proforma_slips TO STDOUT WITH CSV HEADER" > proforma_slips_export.csv
psql $DATABASE_URL -c "COPY proforma_slip_items TO STDOUT WITH CSV HEADER" > proforma_slip_items_export.csv
```

## What's Included in the Export

### Database Tables:
- **users** - User accounts and authentication
- **products** - Product catalog and inventory
- **load_operations** - Loading operation records
- **load_operations_items** - Items within operations
- **proforma_slips** - Generated proforma slips
- **proforma_slip_items** - Items within slips
- **activities** - System activity logs
- **sales** - Sales records
- **orders** - Order management
- **messages** - System messages
- **scan_history** - Barcode scan history
- **session** - Express session storage for authentication

### User Accounts Included:
- **vraj@km-tribe** (Admin) - PIN: 9999 (emergency access)
- **priyank@km-tribe** (Operations)
- **krishna@km-tribe** (User)
- Plus additional configured users

### Product Data:
- Complete product catalog with SKUs
- Barcode associations
- Category classifications
- Volume and dimension data

## Verification Steps

After importing, verify your local setup:

1. **Check table counts:**
   ```sql
   SELECT 
     schemaname,
     tablename,
     n_tup_ins as "rows"
   FROM pg_stat_user_tables
   ORDER BY tablename;
   ```

2. **Test login:**
   - Start your local app: `npm run dev`
   - Access: `http://localhost:5000`
   - Login with PIN: `9999`

3. **Verify data integrity:**
   ```sql
   -- Check user count
   SELECT COUNT(*) FROM users;
   
   -- Check product count  
   SELECT COUNT(*) FROM products;
   
   -- Check operations count
   SELECT COUNT(*) FROM load_operations;
   ```

## Troubleshooting

### Connection Issues
```bash
# Test local connection
psql -U km_finny_user -d km_finny -c "SELECT version();"
```

### Permission Issues
```sql
-- Grant additional permissions if needed
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO km_finny_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO km_finny_user;
```

### Character Encoding Issues
```bash
# Ensure UTF-8 encoding
psql -U km_finny_user -d km_finny -c "SHOW server_encoding;"
```

## Security Notes

- Change default passwords in production
- Use environment variables for sensitive data
- Consider SSL connections for production databases
- Regular backup schedule recommended

## Next Steps

1. Download the database export file
2. Set up local PostgreSQL
3. Import the database
4. Configure environment variables
5. Test the application locally

Your local installation will have all the same data, users, and functionality as the current Replit deployment!