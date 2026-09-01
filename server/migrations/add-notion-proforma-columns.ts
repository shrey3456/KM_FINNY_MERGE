/**
 * Migration script to add the extra Notion-sourced columns to proforma_slips:
 * invoice_number, party_state, notion_status, storekeeper_info, and notion_raw_data
 * (a JSONB snapshot of every property read off the Notion dispatch DB page at import time).
 */

import { db } from "../db";
import { sql } from "drizzle-orm";

const COLUMNS: { name: string; ddl: string }[] = [
  { name: "invoice_number", ddl: "ALTER TABLE proforma_slips ADD COLUMN invoice_number TEXT" },
  { name: "party_state", ddl: "ALTER TABLE proforma_slips ADD COLUMN party_state TEXT" },
  { name: "notion_status", ddl: "ALTER TABLE proforma_slips ADD COLUMN notion_status TEXT" },
  { name: "storekeeper_info", ddl: "ALTER TABLE proforma_slips ADD COLUMN storekeeper_info TEXT" },
  { name: "notion_raw_data", ddl: "ALTER TABLE proforma_slips ADD COLUMN notion_raw_data JSONB" },
];

export async function addNotionProformaColumns() {
  console.log('Starting migration: addNotionProformaColumns - adding Notion metadata columns to proforma_slips table');

  try {
    for (const column of COLUMNS) {
      const columnsResult = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'proforma_slips'
        AND column_name = ${column.name}
      `);

      if (columnsResult.rows && columnsResult.rows.length > 0) {
        console.log(`Column ${column.name} already exists, skipping`);
        continue;
      }

      await db.execute(sql.raw(column.ddl));
      console.log(`Successfully added ${column.name} column to proforma_slips table`);
    }

    return { success: true };
  } catch (error) {
    console.error('Error during migration:', error);
    return { success: false, error };
  }
}

// For running directly with ES modules (using import.meta.url)
const isMainModule = import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMainModule) {
  addNotionProformaColumns()
    .then((result) => {
      console.log('Migration completed:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
