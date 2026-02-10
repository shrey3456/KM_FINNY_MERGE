#!/bin/bash

# Run the improved bulk create sales script
echo "Starting bulk sales creation process..."
node scripts/bulk_create_sales_v3.js

# Get the exit code
exit_code=$?

# Check if the script ran successfully
if [ $exit_code -eq 0 ]; then
  echo "Sales creation completed successfully!"
  echo "Checking current sales count..."
  node scripts/count_sales.mjs
else
  echo "Sales creation encountered errors. Please check the logs."
fi

exit $exit_code