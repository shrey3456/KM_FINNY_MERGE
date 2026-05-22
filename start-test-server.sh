PORT=5533 node dist/index.js &
SERVER_PID=$!
sleep 3
curl -X POST -F "file=@attached_assets/main order csv.csv" -F "plant=Valsad" -F "orderDate=2024-05-22" http://localhost:5533/api/orders/import-csv
kill $SERVER_PID
