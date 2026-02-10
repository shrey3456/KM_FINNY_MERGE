// Migration to add extraQuantity column to proforma_slip_items table

import { db } from '../db';
import { sql } from 'drizzle-orm';

export async function run() {
  console.log("Adding extraQuantity column to proforma_slip_items table...");

  try {
    // Check if the column already exists
    const columnExists = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'proforma_slip_items' 
      AND column_name = 'extra_quantity'
    `);

    if (columnExists.rows.length === 0) {
      // Add extraQuantity column
      await db.execute(sql`
        ALTER TABLE proforma_slip_items 
        ADD COLUMN extra_quantity INTEGER DEFAULT 0
      `);
      console.log("Successfully added extraQuantity column to proforma_slip_items table");
    } else {
      console.log("extraQuantity column already exists in proforma_slip_items table, skipping");
    }

    return { success: true, message: "Migration to add extraQuantity completed successfully" };
  } catch (error) {
    console.error("Error adding extraQuantity column to proforma_slip_items table:", error);
    return { success: false, message: `Error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// If this file is executed directly (for testing), run the migration
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  run()
    .then((result) => {
      console.log(result);
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}