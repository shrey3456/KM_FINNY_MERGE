import { db } from './db';
import { users } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { scrypt, randomBytes } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function fixUserPins() {
  try {
    // Find all users 
    const allUsers = await db.select().from(users);
    
    // Filter to find users with plain text PINs (no dot separator)
    const usersToFix = allUsers.filter(user => !user.pin.includes('.'));
    
    console.log(`Found ${usersToFix.length} users with plain text PINs`);
    
    // Update each user's PIN
    for (const user of usersToFix) {
      console.log(`Processing user: ${user.username} (ID: ${user.id})`);
      
      // Hash the PIN
      const hashedPin = await hashPassword(user.pin);
      
      // Update the user
      await db.update(users)
        .set({ pin: hashedPin })
        .where(eq(users.id, user.id));
      
      console.log(`Updated PIN for user: ${user.username}`);
    }
    
    console.log('All user PINs have been fixed.');
  } catch (error) {
    console.error('Error fixing user PINs:', error);
  } finally {
    process.exit(0);
  }
}

// Run the function
fixUserPins();