import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

// Main function to restore foreign key constraints
async function restoreConstraints() {
  // Create PostgreSQL client
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // Define the foreign key constraints to create
    const constraintDefinitions = [
      {
        table: 'load_operations_items',
        column: 'load_operations_id',
        referencedTable: 'load_operations',
        referencedColumn: 'id',
        onDelete: 'CASCADE'
      },
      {
        table: 'load_operations_items',
        column: 'product_id',
        referencedTable: 'products',
        referencedColumn: 'id',
        onDelete: 'SET NULL'
      },
      {
        table: 'proforma_slip_items',
        column: 'proforma_slip_id',
        referencedTable: 'proforma_slips',
        referencedColumn: 'id',
        onDelete: 'CASCADE'
      },
      {
        table: 'proforma_slip_items',
        column: 'product_id',
        referencedTable: 'products',
        referencedColumn: 'id',
        onDelete: 'SET NULL'
      },
      {
        table: 'sale_items',
        column: 'sale_id',
        referencedTable: 'sales',
        referencedColumn: 'id',
        onDelete: 'CASCADE'
      },
      {
        table: 'scan_history',
        column: 'product_id',
        referencedTable: 'products',
        referencedColumn: 'id',
        onDelete: 'SET NULL'
      },
      {
        table: 'scan_history',
        column: 'scanned_by_id',
        referencedTable: 'users',
        referencedColumn: 'id',
        onDelete: 'SET NULL'
      },
      {
        table: 'sales',
        column: 'created_by_id',
        referencedTable: 'users',
        referencedColumn: 'id',
        onDelete: 'SET NULL'
      },
      {
        table: 'proforma_slips',
        column: 'created_by_id',
        referencedTable: 'users',
        referencedColumn: 'id',
        onDelete: 'SET NULL'
      },
      {
        table: 'load_operations',
        column: 'created_by_id',
        referencedTable: 'users',
        referencedColumn: 'id',
        onDelete: 'SET NULL'
      },
      {
        table: 'activities',
        column: 'user_id',
        referencedTable: 'users',
        referencedColumn: 'id',
        onDelete: 'SET NULL'
      }
    ];
    
    // Add each constraint
    console.log('Creating foreign key constraints...');
    
    for (const constraint of constraintDefinitions) {
      const constraintName = `${constraint.table}_${constraint.column}_fkey`;
      try {
        // Check if constraint already exists
        const checkResult = await client.query(`
          SELECT 1 FROM information_schema.table_constraints 
          WHERE constraint_name = $1 AND table_name = $2
        `, [constraintName, constraint.table]);
        
        if (checkResult.rowCount > 0) {
          console.log(`Constraint ${constraintName} already exists, skipping`);
          continue;
        }
        
        // Create constraint
        await client.query(`
          ALTER TABLE "${constraint.table}"
          ADD CONSTRAINT "${constraintName}"
          FOREIGN KEY ("${constraint.column}")
          REFERENCES "${constraint.referencedTable}" ("${constraint.referencedColumn}")
          ${constraint.onDelete ? `ON DELETE ${constraint.onDelete}` : ''}
        `);
        console.log(`Created constraint ${constraintName}`);
      } catch (error) {
        console.error(`Error creating constraint ${constraintName}:`, error.message);
      }
    }
    
    console.log('Foreign key constraints restoration completed');
    
  } catch (error) {
    console.error('Error during constraint restoration:', error);
  } finally {
    // Close database connection
    await client.end();
    console.log('Database connection closed');
  }
}

// Run the constraint restoration function
restoreConstraints();