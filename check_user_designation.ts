
import { db } from "./server/db";
import { users } from "./shared/schema";
import { eq } from "drizzle-orm";

async function main() {
  console.log("Checking users...");
  try {
    const allUsers = await db.select().from(users);
    console.log("Found users:", allUsers.length);
    for (const u of allUsers) {
      console.log(`User: ${u.username}, UserCode: ${u.userCode}, Dept: '${u.department}', Desig: '${u.designation}'`);
    }
  } catch (error) {
    console.error("Error fetching users:", error);
  }
  process.exit(0);
}

main();
