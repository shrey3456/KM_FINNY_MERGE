// CSV import utility for OrderMaster
import { toast } from "@/hooks/use-toast";

export interface Product {
  id: number;
  srNo: string;
  name: string;
  barcode: string;
  sapCode: string;
}

export interface DealerData {
  id: string;
  name: string;
  displayName: string;
  orderNumber: string;
  plantName: string;
  vehicleNumber: string;
  vehicleVolume: string;
  qtyTotal: number;
}

interface ImportResult {
  dealerColumns: DealerData[];
  quantities: Record<string, Record<string, number>>;
  originalQuantities: Record<string, Record<string, number>>;
}

// Debug import data
export function debugImportData(
  dealerColumns: DealerData[],
  quantities: Record<string, Record<string, number>>,
  products: Product[]
): void {
  console.log("========= CSV IMPORT DEBUG =========");
  console.log(`Found ${dealerColumns.length} dealer columns`);
  console.log(`Found ${Object.keys(quantities).length} products with quantities`);
  
  if (dealerColumns.length > 0) {
    console.log("First dealer:", dealerColumns[0]);
  }
  
  if (Object.keys(quantities).length > 0) {
    const firstProductId = Object.keys(quantities)[0];
    console.log(`First product quantities (ID: ${firstProductId}):`, quantities[firstProductId]);
    
    const matchingProduct = products.find(p => p.id.toString() === firstProductId);
    console.log(`Matching product: ${matchingProduct?.name || 'Not found'}`);
  }
}

// Process CSV format with products in columns (SF Order_Master- VALSAD format)
export function processNewCsvFormat(
  lines: string[], 
  products: Product[]
): ImportResult | null {
  console.log("Processing new CSV format with products in columns");
  
  try {
    // Ensure we have enough data
    if (lines.length < 3) {
      console.error("CSV doesn't have enough lines");
      toast({
        title: 'Invalid CSV Format',
        description: 'The CSV file does not have enough data rows',
        variant: 'destructive',
      });
      return null;
    }
    
    // Debug the first few lines
    console.log("First few CSV lines:");
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      console.log(`Line ${i}: ${lines[i].substring(0, 100)}${lines[i].length > 100 ? '...' : ''}`);
    }
    
    // Find product header row (contains product codes)
    let productHeaderRow = -1;
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      if (lines[i].includes('ProductCode') || 
          lines[i].includes('CRUNCHEM') || 
          lines[i].match(/\d{6}\s*-/)) {
        productHeaderRow = i;
        console.log(`Found product header at line ${i}`);
        break;
      }
    }
    
    if (productHeaderRow === -1) {
      console.error("Could not find product header row");
      toast({
        title: 'CSV Format Error',
        description: 'Could not identify product codes in the CSV file',
        variant: 'destructive',
      });
      return null;
    }
    
    // Find customer row (contains 'Customer' label)
    let customerHeaderRow = -1;
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      if (lines[i].includes('Customer') && !lines[i].includes('ProductCode')) {
        customerHeaderRow = i;
        console.log(`Found customer header at line ${i}`);
        break;
      }
    }
    
    if (customerHeaderRow === -1) {
      console.error("Could not find customer header row");
      customerHeaderRow = productHeaderRow + 1; // Guess it's the next line
      console.log(`Guessing customer header at line ${customerHeaderRow}`);
    }
    
    // Extract product headers
    const productHeaderLine = lines[productHeaderRow];
    const productHeaderCells = productHeaderLine.split(',');
    
    // Skip the first two columns (index and header label)
    const productHeaders = productHeaderCells.slice(2);
    console.log(`Found ${productHeaders.length} product headers`);
    
    // Map products by SAP code
    const productCodeMap: Record<string, Product> = {};
    const productSapCodes: string[] = [];
    
    // Process product headers to extract SAP codes and match with products
    productHeaders.forEach((header, index) => {
      const cleanHeader = header.trim();
      
      // Skip empty headers
      if (!cleanHeader) {
        productSapCodes.push(`empty_${index}`);
        return;
      }
      
      // Try to extract SAP code using different formats
      let sapCode = '';
      let productName = '';
      
      // Format: "123456 - Product Name"
      const dashMatch = cleanHeader.match(/^(\d+)\s*-\s*(.*?)$/);
      if (dashMatch && dashMatch[1]) {
        sapCode = dashMatch[1];
        productName = dashMatch[2]?.trim() || '';
      } 
      // Try to extract any 6-digit code
      else {
        const digitMatch = cleanHeader.match(/(\d{6})/);
        if (digitMatch && digitMatch[1]) {
          sapCode = digitMatch[1];
          productName = cleanHeader.replace(sapCode, '').trim();
        }
      }
      
      // For CRUNCHEM products without clear code
      if (!sapCode && cleanHeader.includes('CRUNCHEM')) {
        sapCode = `CRUNCH_${index}`;
        productName = cleanHeader;
      }
      
      // If we couldn't extract a code, use a placeholder
      if (!sapCode) {
        sapCode = `unknown_${index}`;
        productName = cleanHeader;
      }
      
      productSapCodes.push(sapCode);
      
      // Match with products in database - first try exact match
      let matchingProduct = products.find(p => p.sapCode === sapCode);
      
      // If not found, try partial matching
      if (!matchingProduct && productName) {
        matchingProduct = products.find(p => 
          p.name.toLowerCase().includes(productName.toLowerCase()) ||
          productName.toLowerCase().includes(p.name.toLowerCase())
        );
      }
      
      // If still not found, try matching first digits of SAP code
      if (!matchingProduct && sapCode.match(/^\d+$/)) {
        const sapDigits = sapCode.substring(0, 3);
        matchingProduct = products.find(p => 
          p.sapCode && p.sapCode.startsWith(sapDigits)
        );
      }
      
      // If we found a match, add it to our map
      if (matchingProduct) {
        console.log(`Matched product: ${sapCode} -> ${matchingProduct.name} (ID: ${matchingProduct.id})`);
        productCodeMap[sapCode] = matchingProduct;
      } else {
        console.log(`No product match for: ${sapCode} (${productName})`);
      }
    });
    
    // Start processing customer rows (after customer header row)
    const customerDataStartRow = customerHeaderRow + 1;
    
    // Prepare result objects
    const dealerColumns: DealerData[] = [];
    const quantities: Record<string, Record<string, number>> = {};
    const originalQuantities: Record<string, Record<string, number>> = {};
    
    // Process each customer/dealer row
    console.log(`Processing customer data starting at row ${customerDataStartRow}`);
    
    for (let i = customerDataStartRow; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const cells = line.split(',');
      if (cells.length < 3) continue; // Need at least index, customer, and one quantity
      
      // First column is usually row number/index, second is customer identifier
      const customerIndex = cells[0]?.trim();
      let customerName = cells[1]?.trim();
      
      // Skip rows that don't have a valid customer identifier
      if (!customerName || 
          customerName === 'Customer' || 
          customerName === 'Sum of Dealer Quantity' ||
          customerName.includes('Grand Total')) {
        continue;
      }
      
      console.log(`Processing customer: ${customerName} (row ${i})`);
      
      // Generate a unique dealer ID
      const dealerId = `dealer_${customerName}_${Date.now()}`;
      
      // Create dealer data object
      const dealerData: DealerData = {
        id: dealerId,
        name: customerName,
        displayName: customerName.length === 1 ? `Customer ${customerName}` : customerName,
        orderNumber: `ORD-${customerName}${i.toString().padStart(3, '0')}`,
        plantName: 'Valsad', // Default plant
        vehicleNumber: 'none',
        vehicleVolume: '0',
        qtyTotal: 0
      };
      
      // Extract quantities for this dealer/customer
      let dealerTotal = 0;
      
      // Skip the first two columns (index and customer name)
      const quantityCells = cells.slice(2);
      
      // Map quantities to products
      productSapCodes.forEach((sapCode, index) => {
        // Skip if we're out of bounds
        if (index >= quantityCells.length) return;
        
        const matchingProduct = productCodeMap[sapCode];
        if (!matchingProduct) return;
        
        const productId = matchingProduct.id.toString();
        
        // Get the quantity value
        const quantityStr = quantityCells[index]?.trim() || '0';
        const quantity = parseInt(quantityStr) || 0;
        
        // Only process non-zero quantities
        if (quantity > 0) {
          // Initialize product quantities if needed
          if (!quantities[productId]) {
            quantities[productId] = {};
            originalQuantities[productId] = {};
          }
          
          // Store the quantity
          quantities[productId][dealerId] = quantity;
          originalQuantities[productId][dealerId] = quantity;
          
          // Add to dealer total
          dealerTotal += quantity;
        }
      });
      
      // Only add dealers that have at least one product with quantity
      if (dealerTotal > 0) {
        dealerData.qtyTotal = dealerTotal;
        dealerColumns.push(dealerData);
        console.log(`Added dealer ${dealerData.name} with total quantity ${dealerTotal}`);
      }
    }
    
    console.log(`Parsed ${dealerColumns.length} dealers with quantities`);
    console.log(`Found quantities for ${Object.keys(quantities).length} products`);
    
    // Return the processed data
    return {
      dealerColumns,
      quantities,
      originalQuantities
    };
  } catch (error) {
    console.error("Error in processNewCsvFormat:", error);
    toast({
      title: 'CSV Processing Error',
      description: error instanceof Error ? error.message : 'Unknown error processing CSV',
      variant: 'destructive',
    });
    return null;
  }
}

// Original CSV format with dealers in columns
export function processOldCsvFormat(
  lines: string[], 
  products: Product[]
): ImportResult | null {
  try {
    // Ensure we have enough data
    if (lines.length < 2) {
      toast({
        title: 'Invalid CSV Format',
        description: 'The CSV file does not have enough data rows',
        variant: 'destructive',
      });
      return null;
    }
    
    // Parse headers - first row has column titles
    const headerLine = lines[0];
    const headerCells = headerLine.split(',');
    
    // Find columns for dealer data - start after "Product Name" column (index 1)
    const dealerStartIndex = 2;
    const dealerColumns = headerCells.slice(dealerStartIndex);
    
    // Create result objects
    const newDealerColumns: DealerData[] = [];
    const newQuantities: Record<string, Record<string, number>> = {};
    const newOriginalQuantities: Record<string, Record<string, number>> = {};
    
    // Extract dealer names from headers
    dealerColumns.forEach((dealerName, index) => {
      const cleanName = dealerName.trim();
      const dealerId = `dealer_${index}_${Date.now()}`;
      
      // Create dealer object with default values
      newDealerColumns.push({
        id: dealerId,
        name: cleanName,
        displayName: cleanName,
        orderNumber: `10${(index + 1).toString().padStart(2, '0')}`,
        plantName: 'Valsad',
        vehicleNumber: 'none',
        vehicleVolume: '0',
        qtyTotal: 0
      });
    });
    
    // Process each product row to extract quantities
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const cells = line.split(',');
      const productSrNo = cells[0]?.trim();
      
      // Find product by Sr. No.
      const product = products.find(p => p.srNo === productSrNo);
      if (!product) continue;
      
      const productId = product.id.toString();
      newQuantities[productId] = {};
      newOriginalQuantities[productId] = {};
      
      // Extract quantities for each dealer
      newDealerColumns.forEach((dealer, idx) => {
        const cellIndex = dealerStartIndex + idx;
        const quantityStr = cells[cellIndex]?.trim() || '0';
        const quantity = parseInt(quantityStr) || 0;
        
        newQuantities[productId][dealer.id] = quantity;
        newOriginalQuantities[productId][dealer.id] = quantity;
        
        // Update dealer total
        newDealerColumns[idx].qtyTotal += quantity;
      });
    }
    
    return {
      dealerColumns: newDealerColumns,
      quantities: newQuantities,
      originalQuantities: newOriginalQuantities
    };
  } catch (error) {
    console.error("Error in processOldCsvFormat:", error);
    toast({
      title: 'CSV Processing Error',
      description: error instanceof Error ? error.message : 'Unknown error processing CSV',
      variant: 'destructive',
    });
    return null;
  }
}