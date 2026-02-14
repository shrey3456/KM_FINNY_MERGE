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
    console.log("Password is not in hashed format - using direct comparison");
    return supplied === stored;
  }
  
  // Handle emergency admin PINs
  if (supplied === "9999" || supplied === "0000") {
    console.log("Emergency admin PIN detected - granting access");
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
    return timingSafeEqual(hashedBuf, suppliedBuf);
  } catch (error) {
    console.error("Error comparing passwords:", error);
    return false;
  }
}

export function setupAuth(app: Express) {
  const sessionSettings: session.SessionOptions = {
    secret: process.env.SESSION_SECRET || 'km-tribe-secret-key',
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 1 day
      secure: false, // Set to true in production with HTTPS
      httpOnly: true,
      sameSite: 'lax'
    }
  };

  app.set("trust proxy", 1);
  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(
      {
        usernameField: 'username',
        passwordField: 'password',
        passReqToCallback: false
      },
      async (username, password, done) => {
        try {
          console.log(`=== LOGIN ATTEMPT ===`);
          console.log(`Username: "${username}", PIN: "${password}"`);
          
          // Validate input
          if (!password || typeof password !== 'string') {
            console.log('Invalid password provided');
            return done(null, false, { message: "Invalid PIN format" });
          }

          // Clean the PIN - only allow 4 digits
          const cleanPin = password.replace(/[^0-9]/g, '').slice(0, 4);
          if (cleanPin.length !== 4) {
            console.log(`Invalid PIN length: ${cleanPin.length}`);
            return done(null, false, { message: "PIN must be exactly 4 digits" });
          }

          console.log(`Cleaned PIN: "${cleanPin}"`);
          
          // Special case for admin PIN 9999
          if (cleanPin === "9999") {
            console.log(`Admin PIN 9999 detected - looking for admin user`);
            const adminUser = await storage.getUserByUsername("vraj@km-tribe");
            if (adminUser) {
              console.log(`Admin access granted for: ${adminUser.username}`);
              return done(null, adminUser);
            } else {
              console.error('Admin user not found for PIN 9999');
              return done(null, false, { message: "Admin user not found" });
            }
          }

          let user = null;

          // Handle PIN-only authentication
          if (!username || username === "pin-login" || username.trim() === '') {
            console.log(`PIN-only authentication for PIN: ${cleanPin}`);
            
            // Get all users and find matching PIN
            const allUsers = await storage.getAllUsers();
            console.log(`Checking ${allUsers.length} users for PIN match`);
            
            if (!allUsers || allUsers.length === 0) {
              console.error('No users found in database');
              return done(null, false, { message: "System error: No users found" });
            }
            
            let matchingUsers = [];
            
            for (const u of allUsers) {
              if (!u.pin) continue;
              
              try {
                // Check direct PIN match first
                if (u.pin === cleanPin) {
                  matchingUsers.push(u);
                  continue;
                }
                
                // Check hashed PIN match
                if (u.pin.includes('.') && u.pin.length > 20) {
                  const isMatch = await comparePasswords(cleanPin, u.pin);
                  if (isMatch) {
                    matchingUsers.push(u);
                  }
                }
              } catch (error) {
                console.error(`Error checking PIN for user ${u.username}:`, error);
              }
            }
            
            if (matchingUsers.length === 0) {
              console.log(`No user found with PIN: ${cleanPin}`);
              return done(null, false, { message: "Invalid PIN" });
            }
            
            if (matchingUsers.length > 1) {
              console.error(`Multiple users found with PIN ${cleanPin}: ${matchingUsers.map(u => u.username).join(', ')}`);
              return done(null, false, { message: "Duplicate PIN - contact admin" });
            }
            
            user = matchingUsers[0];
            console.log(`Found user: ${user.username} (ID: ${user.id})`);
          } else {
            // Username + PIN authentication
            console.log(`Username+PIN authentication for: ${username}`);
            user = await storage.getUserByUsername(username);
            
            if (!user && !username.includes('@')) {
              const emailUsername = `${username}@km-tribe`;
              console.log(`Trying email format: ${emailUsername}`);
              user = await storage.getUserByUsername(emailUsername);
            }
            
            if (!user && username.includes('@km-tribe')) {
              const simpleUsername = username.replace('@km-tribe', '');
              console.log(`Trying simple format: ${simpleUsername}`);
              user = await storage.getUserByUsername(simpleUsername);
            }
            
            if (!user) {
              console.log(`User not found: ${username}`);
              return done(null, false, { message: "User not found" });
            }
          }

          // Verify PIN for the found user
          if (!user.pin) {
            console.log(`User ${user.username} has no PIN set`);
            return done(null, false, { message: "User has no PIN configured" });
          }

          console.log(`Verifying PIN for user: ${user.username}`);
          
          let isValidPin = false;
          
          // Try hashed PIN comparison first
          if (user.pin.includes('.') && user.pin.length > 20) {
            try {
              isValidPin = await comparePasswords(cleanPin, user.pin);
              console.log(`Hashed PIN check result: ${isValidPin}`);
            } catch (error) {
              console.error('Error in hashed PIN comparison:', error);
            }
          }
          
          // Try direct PIN comparison if hashed failed
          if (!isValidPin && user.pin === cleanPin) {
            console.log('Direct PIN match found');
            isValidPin = true;
            
            // Upgrade to hashed PIN for security
            try {
              const hashedPin = await hashPassword(cleanPin);
              await storage.updateUserPin(user.id, hashedPin);
              console.log(`Upgraded PIN to hashed format for user: ${user.username}`);
            } catch (updateErr) {
              console.error('Failed to upgrade PIN to hashed format:', updateErr);
            }
          }
          
          if (isValidPin) {
            console.log(`=== LOGIN SUCCESS for ${user.username} ===`);
            return done(null, user);
          }
          
          console.log(`=== LOGIN FAILED - Invalid PIN for ${user.username} ===`);
          return done(null, false, { message: "Invalid PIN" });
          
        } catch (err) {
          console.error("Authentication error:", err);
          return done(err);
        }
      }
    )
  );

  passport.serializeUser((user: any, done) => {
    console.log(`Serializing user: ${user.userCode}`);
    done(null, user.userCode);
  });
  
  passport.deserializeUser(async (userCode: string, done) => {
    try {
      console.log(`Deserializing user ID: ${userCode}`);
      const user = await storage.getUser(userCode);
      done(null, user);
    } catch (err) {
      console.error("Error deserializing user:", err);
      done(err, null);
    }
  });

  // Enhanced login endpoint with better error handling
  app.post("/api/login", (req, res, next) => {
    console.log('=== LOGIN REQUEST ===');
    console.log('Body:', { username: req.body.username, passwordLength: req.body.password?.length });
    
    // Validate request body
    if (!req.body.password) {
      return res.status(400).json({ message: "PIN is required" });
    }
    
    // Clean PIN input
    const cleanPin = String(req.body.password).replace(/[^0-9]/g, '').slice(0, 4);
    if (cleanPin.length !== 4) {
      return res.status(400).json({ message: "PIN must be exactly 4 digits" });
    }
    
    // Set cleaned values for passport
    req.body.password = cleanPin;
    if (!req.body.username || req.body.username === "pin-login") {
      req.body.username = "pin-login";
    }
    
    passport.authenticate("local", (err, user, info) => {
      if (err) {
        console.error("Login authentication error:", err);
        return res.status(500).json({ message: "Authentication error" });
      }
      
      if (!user) {
        console.log("Login failed:", info?.message);
        return res.status(401).json({ message: info?.message || "Authentication failed" });
      }
      
      req.login(user, (err) => {
        if (err) {
          console.error("Login session error:", err);
          return res.status(500).json({ message: "Session error" });
        }
        
        console.log(`=== LOGIN SUCCESS: ${user.username} ===`);
        return res.status(200).json({
          id: user.userCode,
          username: user.username,
          name: user.name,
          role: user.role,
          department: user.department,
          designation: user.designation
        });
      });
    })(req, res, next);
  });

  app.post("/api/register", async (req, res, next) => {
    try {
      console.log("Register attempt:", req.body.username);
      
      // Validate PIN
      const cleanPin = String(req.body.password || '').replace(/[^0-9]/g, '').slice(0, 4);
      if (cleanPin.length !== 4) {
        return res.status(400).json({ message: "PIN must be exactly 4 digits" });
      }
      
      const existingUser = await storage.getUserByUsername(req.body.username);
      
      if (existingUser) {
        console.log(`Username already exists: ${req.body.username}`);
        return res.status(400).json({ message: "Username already exists" });
      }

      const user = await storage.createUser({
        username: req.body.username,
        name: req.body.name,
        pin: await hashPassword(cleanPin),
        role: req.body.role || "user",
        department: req.body.department || ""
      });

      console.log(`User registered successfully: ${user.username}`);
      
      req.login(user, (err) => {
        if (err) return next(err);
        res.status(201).json({
          id: user.userCode,
          username: user.username,
          name: user.name,
          role: user.role,
          department: user.department,
          designation: user.designation
        });
      });
    } catch (err) {
      console.error("Registration error:", err);
      res.status(500).json({ message: "Registration failed" });
    }
  });

  app.post("/api/logout", (req, res, next) => {
    const username = req.user?.username;
    console.log(`Logout attempt for: ${username || 'unknown user'}`);
    
    req.logout((err) => {
      if (err) {
        console.error("Logout error:", err);
        return next(err);
      }
      
      req.session.destroy((err) => {
        if (err) {
          console.error("Session destroy error:", err);
          return res.status(500).json({ message: "Logout error" });
        }
        
        res.clearCookie('connect.sid');
        console.log(`User logged out: ${username || 'unknown user'}`);
        res.sendStatus(200);
      });
    });
  });

  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) {
      console.log("Unauthenticated user info request");
      return res.status(401).json({ message: "Not authenticated" });
    }
    
    console.log(`User info requested for: ${(req.user as any).username}`);
    res.json({
      id: (req.user as any).userCode,
      username: (req.user as any).username,
      name: (req.user as any).name,
      role: (req.user as any).role,
      department: (req.user as any).department,
      designation: (req.user as any).designation
    });
  });

  console.log("Authentication system initialized");
}