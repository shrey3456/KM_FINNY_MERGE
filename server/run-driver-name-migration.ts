/**
 * Script to run the migration to add driver_name column to load_operations table
 */

import { addDriverNameColumn } from './migrations/add-driver-name';

async function runMigration() {
  try {
    console.log('Starting migration process for adding driver_name to load_operations table...');
    
    const result = await addDriverNameColumn();
    
    if (result.success) {
      console.log('✅ Migration completed successfully!');
    } else {
      console.error('❌ Migration failed:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Unhandled error during migration:', error);
    process.exit(1);
  }
}

// Run the migration if this script is executed directly
const isMainModule = import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMainModule) {
  runMigration()
    .then(() => {
      console.log('Migration process completed. Exiting.');
      process.exit(0);
    })
    .catch(error => {
      console.error('Fatal error during migration:', error);
      process.exit(1);
    });
}