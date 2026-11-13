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

// Populated by setupAuth() below — reused by the WebSocket upgrade handler
// (server/routes/order-scan.ts) to authenticate a WS connection the same way an HTTP
// request is authenticated, since the raw upgrade `request` never passes through Express's
// own app.use(session(...)) middleware chain on its own.
export let sessionMiddleware: ReturnType<typeof session> | null = null;

export function setupAuth(app: Express) {
  // Detect deployment environment more reliably
  const isProduction = process.env.NODE_ENV === 'production';
  
  // Use secure cookies only in true HTTPS environments
  // For development and local testing, disable secure cookies to allow HTTP
  const useSecureCookies = isProduction && process.env.HTTPS === 'true';
  
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be set in .env");
  }

  const sessionSettings: session.SessionOptions = {
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      maxAge: 24 *60 * 60 * 1000, // 1 day
      secure: useSecureCookies, // Only use secure cookies when appropriate
      httpOnly: true,
      // Fix Windows compatibility - use 'lax' for better cross-platform support
      sameSite: 'lax' , // Use 'lax' for Windows compatibility instead of 'none'
      // Don't set domain - let it default to the current domain
    },
    // Add better error handling
    name: 'team-finny-session',
    // Rolling sessions to keep users logged in
    rolling: false, // Don't reset maxAge on every response - adjust as needed
  };

  // Add debug logging for session issues in deployment
  console.log(`Authentication setup - Production mode: ${isProduction}`);
  console.log(`Session cookie settings - secure: ${sessionSettings.cookie?.secure}, sameSite: ${sessionSettings.cookie?.sameSite}`);
  
  app.set("trust proxy", 1);
  sessionMiddleware = session(sessionSettings);
  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        console.log(`----- NEW LOGIN ATTEMPT -----`);
        console.log(`Login attempt for username: ${username || 'empty'}, PIN length: ${password.length}`);
        
        // Step 1: Try to find the user with the exact username
        let user = null;
        
        // Handle PIN-only authentication for our app
        if ((!username || username === "pin-login" || username.trim() === '') && password.length === 4) {
          
          // Security check: Prevent generic PINs that could match multiple users
          if (password === "0000" || password === "1111" || password === "1234" || password === "9999") {
            // For these generic PINs, we need exact username match, not just PIN
            if (!username || username === "pin-login") {
              console.log(`Authentication failed: generic PIN requires explicit username`);
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
            console.error(`Authentication failed:  users share the entered PIN`);
            console.error(`Users with this PIN: ${matchingUsers.map(u => u.username).join(', ')}`);
            return done(null, false, { message: "Ambiguous PIN - please use username" });
          } else if (matchingUsers.length === 1) {
            // Exactly one user found with this PIN - this is what we want
            pinUser = matchingUsers[0];
            console.log(`Found exactly one user ${pinUser.username} (code: ${pinUser.userCode}) with matching PIN`);
            user = pinUser;
          } else {
            // No matching user found
            console.log(`Authentication failed: no user found with that PIN`);
            return done(null, false, { message: "Invalid PIN" });
          }
        } else {
          // Username+PIN authentication
          user = await storage.getUserByUsername(username);
          console.log(`Lookup by exact username '${username}': ${user ? 'found' : 'not found'}`);
          
          // If not found, try with the @team-finny suffix
          if (!user && !username.includes('@')) {
            const emailUsername = `${username}@team-finny`;
            console.log(`Trying alternative username format: ${emailUsername}`);
            user = await storage.getUserByUsername(emailUsername);
            console.log(`Lookup by email username '${emailUsername}': ${user ? 'found' : 'not found'}`);
          }
          
          // If still not found and username has @team-finny, try without it
          if (!user && username.includes('@team-finny')) {
            const simpleUsername = username.replace('@team-finny', '');
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
        console.log(`Verifying PIN for user: ${user.username} (code: ${user.userCode})`);
        
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
        }
        
        if (isValidPin) {
          console.log(`Authentication successful for user: ${user.username} (code: ${user.userCode})`);
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
    
    // Ensure we have a valid userCode
    if (!user.userCode) {
      console.error(`[SERIALIZE] ERROR: User ${user.username} has no userCode! Cannot serialize.`);
      done(new Error('User missing userCode'), null);
      return;
    }
    
    done(null, user.userCode);
  });
  
  passport.deserializeUser(async (identifier: string, done) => {
    try {
      
      if (!identifier) {
        return done(null, false);
      }
      
      // Direct userCode lookup (no more fallback to numeric IDs)
      const user = await storage.getUserByUserCode(identifier);
      
      if (user) {
        done(null, user);
      } else {
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
    passport.authenticate("local", (err: any, user: Express.User | false, info: { message?: string } | undefined) => {
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
    // Identity/permissions must never be served stale — a page grant an admin just made
    // (allowedPages/pageWriteAccess) has to be visible on this user's very next request,
    // not whatever a browser or intermediate proxy (this app runs behind IIS) cached.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");

    if (!req.isAuthenticated()) {
      console.log("Unauthenticated user info request");
      return res.status(401).json({ message: "Not authenticated" });
    }

    console.log(`User info requested for: ${req.user.username}`);
    res.json(req.user);
  });
}

