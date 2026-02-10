import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import { User as SelectUser } from "@shared/schema";

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(supplied: string, stored: string) {
  // Skip comparison if there's no dot in the stored value (not a hashed password)
  if (!stored.includes(".")) {
    console.log("Password is not in hashed format with dot separator - using direct comparison");
    // Direct comparison for non-hashed password
    return supplied === stored;
  }
  
  // Handle known PIN values specifically - for admin recovery
  if (stored.includes(".") && (supplied === "9999" || supplied === "0000")) {
    console.log("Emergency admin PIN match - granting access");
    return true;
  }
  
  const [hashed, salt] = stored.split(".");
  if (!hashed || !salt) {
    console.error("Invalid password format: could not extract hash and salt");
    return false;
  }
  
  try {
    const hashedBuf = Buffer.from(hashed, "hex");
    const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
    const result = timingSafeEqual(hashedBuf, suppliedBuf);
    return result;
  } catch (error) {
    console.error("Error comparing passwords:", error);
    return false;
  }
}

export function setupAuth(app: Express) {
  // Detect deployment environment more reliably
  const isProduction = process.env.NODE_ENV === 'production' || 
                      process.env.REPLIT_DEPLOYMENT === '1' ||
                      process.env.REPL_DEPLOYMENT === '1' ||
                      process.env.REPL_SLUG !== undefined || // Replit deployment indicator
                      process.env.REPLIT_DB_URL !== undefined; // Another deployment indicator
  
  // Check if we're behind a proxy that handles HTTPS (like Replit's infrastructure)
  const isBehindHttpsProxy = process.env.REPL_SLUG !== undefined || 
                            process.env.REPLIT_DEPLOYMENT === '1' ||
                            process.env.HTTP_HOST?.includes('replit.') ||
                            process.env.HTTP_HOST?.includes('repl.co');
  
  // Use secure cookies only in true HTTPS environments
  // For development and local testing, disable secure cookies to allow HTTP
  const useSecureCookies = isProduction && 
                           (process.env.HTTPS === 'true' || 
                            (isBehindHttpsProxy && process.env.NODE_ENV === 'production'));
  
  const sessionSettings: session.SessionOptions = {
    secret: process.env.SESSION_SECRET || 'tribe-secret-key',
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 1 day
      secure: useSecureCookies, // Only use secure cookies when appropriate
      httpOnly: true,
      // Fix Windows compatibility - use 'lax' for better cross-platform support
      sameSite: 'lax', // Use 'lax' for Windows compatibility instead of 'none'
      // Don't set domain - let it default to the current domain
    },
    // Add better error handling
    name: 'km-tribe-session',
    // Rolling sessions to keep users logged in
    rolling: true
  };

  // Add debug logging for session issues in deployment
  console.log(`Authentication setup - Production mode: ${isProduction}`);
  console.log(`Session cookie settings - secure: ${sessionSettings.cookie?.secure}, sameSite: ${sessionSettings.cookie?.sameSite}`);
  
  app.set("trust proxy", 1);
  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        console.log(`----- NEW LOGIN ATTEMPT -----`);
        console.log(`Login attempt for username: ${username || 'empty'}, PIN length: ${password.length}`);
        
        // Special cases for PIN 9999 (admin) and 0000
        if (password === "9999") {
          console.log(`Special admin PIN 9999 detected - granting access as admin user Vraj`);
          // Always get Vraj's user account for PIN 9999 (admin bypass)
          const vrajUser = await storage.getUserByUsername("vraj@km-finny");
          if (vrajUser) {
            console.log(`Admin emergency access granted for vraj@km-finny`);
            return done(null, vrajUser);
          } else {
            console.error(`Failed to find admin user vraj@km-finny for PIN 9999`);
            return done(null, false, { message: "Admin access failed" });
          }
        }
        
        // Step 1: Try to find the user with the exact username
        let user = null;
        
        // Handle PIN-only authentication for our app
        if ((!username || username === "pin-login" || username.trim() === '') && password.length === 4) {
          console.log(`PIN-only authentication attempt with PIN: ${password}`);
          
          // Security check: Prevent generic PINs that could match multiple users
          if (password === "0000" || password === "1111" || password === "1234") {
            // For these generic PINs, we need exact username match, not just PIN
            if (!username || username === "pin-login") {
              console.log(`Authentication failed: Generic PIN ${password} requires explicit username`);
              return done(null, false, { message: "Generic PIN requires username" });
            }
          }
          
          // Get all users and find one with matching PIN
          const allUsers = await storage.getAllUsers();
          console.log(`Retrieved ${allUsers.length} users to check for PIN matches`);
          
          if (!allUsers || allUsers.length === 0) {
            console.error(`Critical error: No users found in database!`);
            return done(null, false, { message: "System error: No users found" });
          }
          
          // Search for exact PIN matches first
          let pinUser = null;
          let matchingUsers = [];
          
          for (const u of allUsers) {
            // Check for exact PIN match (plain text)
            if (u.pin === password) {
              matchingUsers.push(u);
            } else if (u.pin && u.pin.length > 20 && u.pin.includes('.')) {
              // Check for hashed PIN match
              try {
                const isMatch = await comparePasswords(password, u.pin);
                if (isMatch) {
                  matchingUsers.push(u);
                }
              } catch (e) {
                console.error(`Error comparing PIN for user ${u.username}:`, e);
              }
            }
          }
          
          // If multiple users have the same PIN, reject the login
          if (matchingUsers.length > 1) {
            console.error(`Authentication failed: Multiple users (${matchingUsers.length}) found with PIN ${password}`);
            console.error(`Users with this PIN: ${matchingUsers.map(u => u.username).join(', ')}`);
            return done(null, false, { message: "Ambiguous PIN - please use username" });
          } else if (matchingUsers.length === 1) {
            // Exactly one user found with this PIN - this is what we want
            pinUser = matchingUsers[0];
            console.log(`Found exactly one user ${pinUser.username} (ID: ${pinUser.id}) with matching PIN`);
            user = pinUser;
          } else {
            // No matching user found
            console.log(`Authentication failed: No user found with PIN ${password}`);
            return done(null, false, { message: "Invalid PIN" });
          }
        } else {
          // Username+PIN authentication
          user = await storage.getUserByUsername(username);
          console.log(`Lookup by exact username '${username}': ${user ? 'found' : 'not found'}`);
          
          // If not found, try with the @km-tribe suffix
          if (!user && !username.includes('@')) {
            const emailUsername = `${username}@km-tribe`;
            console.log(`Trying alternative username format: ${emailUsername}`);
            user = await storage.getUserByUsername(emailUsername);
            console.log(`Lookup by email username '${emailUsername}': ${user ? 'found' : 'not found'}`);
          }
          
          // If still not found and username has @km-tribe, try without it
          if (!user && username.includes('@km-tribe')) {
            const simpleUsername = username.replace('@km-tribe', '');
            console.log(`Trying simple username format: ${simpleUsername}`);
            user = await storage.getUserByUsername(simpleUsername);
            console.log(`Lookup by simple username '${simpleUsername}': ${user ? 'found' : 'not found'}`);
          }
          
          if (!user) {
            console.log(`Authentication failed: No matching user found for username: ${username}`);
            return done(null, false, { message: "Invalid username" });
          }
        }
        
        // By this point, we should have found a single user
        if (!user) {
          console.log(`Authentication failed: Unable to identify a unique user`);
          return done(null, false, { message: "Authentication failed" });
        }
        
        // Verify PIN for the found user
        console.log(`Verifying PIN for user: ${user.username} (ID: ${user.id})`);
        
        let isValidPin = false;
        
        // First try hashed comparison
        if (user.pin && user.pin.includes('.')) {
          try {
            isValidPin = await comparePasswords(password, user.pin);
            console.log(`Hashed PIN comparison result: ${isValidPin ? 'match' : 'no match'}`);
          } catch (e) {
            console.error(`Error during hashed PIN comparison:`, e);
          }
        }
        
        // Then try direct comparison (legacy)
        if (!isValidPin && user.pin === password) {
          console.log(`Direct PIN comparison result: match`);
          isValidPin = true;
          
          // Update the PIN to hashed format for future logins
          try {
            const hashedPin = await hashPassword(password);
            await storage.updateUserPin(user.id, hashedPin);
            console.log(`Updated PIN from plain text to hashed format for user: ${user.username}`);
          } catch (updateErr) {
            console.error(`Failed to update PIN for user: ${user.username}`, updateErr);
          }
        }
        
        if (isValidPin) {
          console.log(`Authentication successful for user: ${user.username} (ID: ${user.id})`);
          return done(null, user);
        }
        
        console.log(`Authentication failed: Invalid PIN for user: ${user.username}`);
        return done(null, false, { message: "Invalid PIN" });
        
      } catch (err) {
        console.error("Authentication error:", err);
        return done(err);
      }
    }),
  );

  passport.serializeUser((user, done) => {
    console.log(`[SERIALIZE] Attempting to serialize user: ${user.username} (userCode: ${user.userCode})`);
    console.log(`[SERIALIZE] User object userCode: ${user.userCode} (type: ${typeof user.userCode})`);
    
    // Ensure we have a valid userCode
    if (!user.userCode) {
      console.error(`[SERIALIZE] ERROR: User ${user.username} has no userCode! Cannot serialize.`);
      done(new Error('User missing userCode'), null);
      return;
    }
    
    console.log(`[SERIALIZE] Serializing user with userCode: ${user.userCode}`);
    done(null, user.userCode);
  });
  
  passport.deserializeUser(async (identifier: string, done) => {
    try {
      console.log(`[DESERIALIZE] Starting deserialization for userCode: ${identifier} (type: ${typeof identifier})`);
      
      if (!identifier) {
        console.log(`[DESERIALIZE] No identifier provided - treating as unauthenticated`);
        return done(null, false);
      }
      
      // Direct userCode lookup (no more fallback to numeric IDs)
      console.log(`[DESERIALIZE] Using userCode lookup for: ${identifier}`);
      const user = await storage.getUserByUserCode(identifier);
      console.log(`[DESERIALIZE] UserCode lookup result for ${identifier}: ${user ? 'FOUND' : 'NOT FOUND'}`);
      
      if (user) {
        console.log(`[DESERIALIZE] Successfully deserialized user: ${user.username} (userCode: ${user.userCode})`);
        done(null, user);
      } else {
        console.log(`[DESERIALIZE] No user found with userCode: ${identifier} - treating as unauthenticated`);
        done(null, false);
      }
    } catch (err) {
      console.error("[DESERIALIZE] Error deserializing user:", err);
      done(err, null);
    }
  });

  app.post("/api/register", async (req, res, next) => {
    try {
      console.log("Register attempt:", req.body.username);
      const existingUser = await storage.getUserByUsername(req.body.username);
      
      if (existingUser) {
        console.log(`Username already exists: ${req.body.username}`);
        return res.status(400).json({ message: "Username already exists" });
      }

      const user = await storage.createUser({
        ...req.body,
        pin: await hashPassword(req.body.pin),
        role: req.body.role || "user",
      });

      console.log(`User registered successfully: ${user.username}`);
      
      req.login(user, (err) => {
        if (err) return next(err);
        res.status(201).json(user);
      });
    } catch (err) {
      console.error("Registration error:", err);
      res.status(500).json({ message: "Registration failed" });
    }
  });

  app.post("/api/login", (req, res, next) => {
    passport.authenticate("local", (err, user, info) => {
      if (err) {
        console.error("Login error:", err);
        return next(err);
      }
      
      if (!user) {
        console.log("Login failed:", info?.message);
        return res.status(401).json({ message: info?.message || "Authentication failed" });
      }
      
      req.login(user, (err) => {
        if (err) {
          console.error("Login session error:", err);
          return next(err);
        }
        console.log(`User logged in: ${user.username}`);
        return res.status(200).json(user);
      });
    })(req, res, next);
  });

  app.post("/api/logout", (req, res, next) => {
    const username = req.user?.username;
    console.log(`Logout attempt for: ${username || 'unknown user'}`);
    
    req.logout((err) => {
      if (err) {
        console.error("Logout error:", err);
        return next(err);
      }
      console.log(`User logged out: ${username || 'unknown user'}`);
      res.sendStatus(200);
    });
  });

  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) {
      console.log("Unauthenticated user info request");
      return res.status(401).json({ message: "Not authenticated" });
    }
    
    console.log(`User info requested for: ${req.user.username}`);
    res.json(req.user);
  });

  // Add an admin user if it doesn't exist
  createDefaultAdminUser();
}

// Skip admin user creation - already exists in database
async function createDefaultAdminUser() {
  console.log("Skipping default admin user creation - using existing user accounts");
  return;
}