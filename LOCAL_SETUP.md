# KM Finny - Local Development Setup

This guide will help you run the KM Finny warehouse management system on your local machine.

## Prerequisites

Make sure you have the following installed on your system:

### Required Software
- **Node.js** (version 18 or higher)
  - Download from: https://nodejs.org/
  - Verify installation: `node --version`
- **npm** (comes with Node.js)
  - Verify installation: `npm --version`
- **PostgreSQL** (version 12 or higher)
  - Download from: https://www.postgresql.org/download/
  - Or use Docker: `docker run --name postgres -e POSTGRES_PASSWORD=password -p 5432:5432 -d postgres`

## Step 1: Clone and Setup Project

1. **Download/Clone the project files** to your local machine

2. **Install dependencies:**
   ```bash
   npm install
   ```

## Step 2: Database Setup

### Option A: Local PostgreSQL Installation

1. **Create a database:**
   ```sql
   -- Connect to PostgreSQL as superuser
   psql -U postgres
   
   -- Create database and user
   CREATE DATABASE km_finny;
   CREATE USER km_finny_user WITH PASSWORD 'your_secure_password';
   GRANT ALL PRIVILEGES ON DATABASE km_finny TO km_finny_user;
   ```

2. **Create environment file:**
   ```bash
   # Create .env file in project root
   touch .env
   ```

3. **Configure environment variables** (add to `.env` file):
   ```env
   # Database Configuration
   DATABASE_URL=postgresql://km_finny_user:your_secure_password@localhost:5432/km_finny
   
   # Session Configuration
   SESSION_SECRET=your-super-secret-session-key-change-this-in-production
   
   # Development Settings
   NODE_ENV=development
   PORT=5000
   ```

### Option B: Using Docker for PostgreSQL

1. **Start PostgreSQL container:**
   ```bash
   docker run --name km-finny-postgres \
     -e POSTGRES_DB=km_finny \
     -e POSTGRES_USER=km_finny_user \
     -e POSTGRES_PASSWORD=secure_password \
     -p 5432:5432 \
     -d postgres:15
   ```

2. **Configure environment variables** (add to `.env` file):
   ```env
   DATABASE_URL=postgresql://km_finny_user:secure_password@localhost:5432/km_finny
   SESSION_SECRET=your-super-secret-session-key-change-this-in-production
   NODE_ENV=development
   PORT=5000
   ```

## Step 3: Database Migration

1. **Create session table for authentication:**
   
   **Option A: Using provided SQL script (Recommended):**
   ```bash
   # Run the session table creation script
   psql -U km_finny_user -d km_finny -f scripts/create_session_table.sql
   ```
   
   **Option B: Manual SQL execution:**
   ```sql
   -- Connect to your database
   psql -U km_finny_user -d km_finny
   
   -- Create session table for Express session storage
   CREATE TABLE IF NOT EXISTS session (
     sid TEXT PRIMARY KEY,
     sess TEXT NOT NULL,
     expire TIMESTAMP NOT NULL
   );
   ```

2. **Run database migrations to set up the schema:**
   ```bash
   # Push database schema (this creates all tables)
   npm run db:push
   ```

   **Note:** If you encounter column conflicts during migration, that's normal for existing databases. The session table created above is required for authentication to work properly.

## Step 4: Start the Application

### Development Mode (Recommended)
```bash
# Starts both frontend and backend with hot reload
npm run dev
```

### Production Mode
```bash
# Build the application
npm run build

# Start the production server
npm start
```

## Step 5: Access the Application

1. **Open your browser** and navigate to:
   ```
   http://localhost:5000
   ```

2. **Login with admin credentials:**
   - Use PIN: `9999` (emergency admin access)
   - This will log you in as the admin user

## Project Structure

```
km-finny/
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── pages/         # Page components
│   │   ├── lib/           # Utilities and helpers
│   │   └── hooks/         # Custom React hooks
├── server/                # Node.js backend
│   ├── routes.ts          # API routes
│   ├── storage.ts         # Database operations
│   ├── auth.ts           # Authentication logic
│   └── migrations/       # Database migrations
├── shared/               # Shared types and schemas
│   └── schema.ts         # Database schema definitions
├── public/              # Static assets
└── package.json         # Dependencies and scripts
```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run db:push` - Push schema changes to database
- `npm run db:studio` - Open Drizzle Studio (database GUI)

## Features Available Locally

✅ **Load Operations Management** - Create and manage loading operations
✅ **Product Inventory** - Manage products and inventory
✅ **Proforma Slip Generation** - Generate and print proforma slips
✅ **User Management** - Multi-role user system
✅ **Barcode Scanning** - Product scanning functionality
✅ **Data Export/Import** - CSV export and import capabilities
✅ **Offline Support** - PWA with offline capabilities

## Troubleshooting

### Database Connection Issues
- Verify PostgreSQL is running: `pg_isready`
- Check connection string in `.env` file
- Ensure database exists and user has permissions

### Port Already in Use
```bash
# Kill process using port 5000
lsof -ti:5000 | xargs kill -9

# Or use a different port
PORT=3000 npm run dev
```

### Dependencies Issues
```bash
# Clear npm cache and reinstall
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

### Permission Issues (macOS/Linux)
```bash
# Fix npm permissions
sudo chown -R $(whoami) ~/.npm
```

## Default User Accounts

The system includes several pre-configured user accounts:

- **Admin Access**: PIN `9999` (emergency admin)
- **Vraj**: Admin user with full permissions
- **Priyank**: Operations user
- **Additional users**: Various roles and permissions

All usernames use the `@km-tribe` extension (e.g., `vraj@km-tribe`).

## Development Tips

1. **Database Changes**: Use `npm run db:push` to apply schema changes
2. **Code Changes**: The dev server auto-reloads on file changes
3. **Debugging**: Check browser console and terminal for error messages
4. **Database GUI**: Use `npm run db:studio` to view/edit data graphically

## Production Deployment

For production deployment, ensure:
- Use secure database credentials
- Set strong SESSION_SECRET
- Configure HTTPS
- Set NODE_ENV=production
- Use proper logging and monitoring

---

**Support**: If you encounter issues, check the logs in the terminal and browser console for specific error messages.