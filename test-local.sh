PORT=7001 node dist/index.js &
SERVER_PID=$!
sleep 3
echo "Sending curl request for 23.04.2025..."
curl -v -X POST -F "file=@attached_assets/main order 23.04.2025.csv" -F "plant=Valsad" -F "orderDate=2024-05-22" http://localhost:7001/api/orders/import-csv
echo ""
kill $SERVER_PID
