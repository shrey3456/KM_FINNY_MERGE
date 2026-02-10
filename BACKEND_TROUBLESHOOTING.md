# Backend Startup Troubleshooting Guide

## Common Issues and Solutions

### 1. Database Connection Issues

**Symptoms:**
- Backend fails to start
- Database connection errors
- "terminating connection due to administrator command"

**Solutions:**

#### Check Environment Variables
```bash
# Verify DATABASE_URL is set
echo $DATABASE_URL

# Should show PostgreSQL connection string
# If not set, configure .env file
```

#### Fix .env Configuration
```env
# Use the correct Replit database URL
DATABASE_URL=postgresql://neondb_owner:npg_WfN9rFaIo4OzXJIqBGJjlh8vHKvIJNYQ@ep-twilight-fire-a5o6hqjz.us-east-2.aws.neon.tech/neondb?sslmode=require

# Add session secret
SESSION_SECRET=km-finny-super-secure-session-secret-key-2025-production-change-this

# Development settings
NODE_ENV=development
PORT=5000
```

### 2. Port Already in Use

**Symptoms:**
- "EADDRINUSE: address already in use :::5000"

**Solutions:**
```bash
# Kill process using port 5000
lsof -ti:5000 | xargs kill -9

# Or use a different port
PORT=3000 npm run dev
```

### 3. TypeScript/Node.js Issues

**Symptoms:**
- Module resolution errors
- TypeScript compilation errors

**Solutions:**
```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Check TypeScript compilation
npm run check
```

### 4. Missing Dependencies

**Symptoms:**
- "Cannot find module" errors

**Solutions:**
```bash
# Install missing dependencies
npm install

# For specific packages
npm install express @types/express tsx
```

### 5. Database Schema Issues

**Symptoms:**
- Database table not found errors
- Schema mismatch errors

**Solutions:**
```bash
# Push schema to database
npm run db:push

# Check database connection
psql $DATABASE_URL -c "SELECT version();"
```

### 6. WebSocket Connection Issues

**Symptoms:**
- WebSocket connection failures
- 400 errors on /ws endpoint

**Solutions:**
The WebSocket functionality has been temporarily disabled to prevent app loading issues. To re-enable:

1. Check `client/src/pages/LoadOperations.tsx`
2. Uncomment the `setupWebSocket()` calls
3. Ensure WebSocket server is properly configured

### 7. Session/Authentication Issues

**Symptoms:**
- Session store errors
- Authentication failures

**Solutions:**
```bash
# Ensure SESSION_SECRET is set
echo $SESSION_SECRET

# Check session table exists
psql $DATABASE_URL -c "\dt" | grep session
```

## Startup Checklist

Before starting the backend, verify:

- [ ] `.env` file exists with correct DATABASE_URL
- [ ] DATABASE_URL contains valid PostgreSQL connection string
- [ ] SESSION_SECRET is set (minimum 32 characters)
- [ ] Port 5000 is available (or use different port)
- [ ] Dependencies are installed (`node_modules` exists)
- [ ] Database is accessible
- [ ] No TypeScript compilation errors

## Quick Start Commands

```bash
# 1. Install dependencies
npm install

# 2. Check environment
cat .env

# 3. Test database connection
psql $DATABASE_URL -c "SELECT 1;"

# 4. Push database schema if needed
npm run db:push

# 5. Start development server
npm run dev
```

## Development vs Production

### Development Mode
```bash
NODE_ENV=development npm run dev
```
- Uses tsx for TypeScript execution
- Hot reload enabled
- Vite development server
- Detailed error messages

### Production Mode
```bash
# Build first
npm run build

# Then start
NODE_ENV=production npm start
```
- Uses compiled JavaScript
- Optimized for performance
- Static file serving
- Minimal error output

## Debugging Steps

1. **Check logs:** Look for specific error messages in terminal
2. **Verify .env:** Ensure all required variables are set
3. **Test database:** Try connecting directly with psql
4. **Check dependencies:** Verify all packages are installed
5. **Clear cache:** Remove node_modules and reinstall
6. **Check TypeScript:** Run `npm run check` for compilation errors

## Environment Variables Reference

### Required
- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Session encryption key

### Optional
- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 5000)

## Local Development Notes

When running locally instead of Replit:

1. Use local PostgreSQL database URL
2. Change SESSION_SECRET for security
3. Adjust PORT if needed
4. Set NODE_ENV=development
5. Ensure all dependencies are installed locally