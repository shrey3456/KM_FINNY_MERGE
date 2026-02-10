#!/bin/bash

# List of tables to import in proper order
tables=(
  "vehicle_info"
  "products"
  "proforma_slips"
  "proforma_slip_items"
  "load_operations"
  "load_operations_items"
  "scan_history"
  "sales"
  "sale_items"
  "activities"
  "messages"
  "backup_settings"
)

# Import each table
for table in "${tables[@]}"; do
  echo "Importing $table..."
  node scripts/import_single_table.js "$table"
  echo "Completed import of $table"
  echo "-----------------------------"
done

echo "All imports completed successfully!"