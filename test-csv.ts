import { readFileSync } from 'fs';

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseProductDescriptor(descriptor: string) {
  const clean = descriptor.trim();
  const match = clean.match(/^(\d+)\s*-\s*(.+)$/);

  if (match) {
    return {
      sapCode: match[1],
      name: match[2].trim(),
    };
  }

  return {
    sapCode: clean.match(/\d{5,}/)?.[0],
    name: clean || 'Imported Product',
  };
}

function toQuantity(value: string | undefined) {
  const numericValue = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(numericValue) && numericValue > 0 ? Math.round(numericValue) : 0;
}

const text = readFileSync('attached_assets/main order csv.csv', 'utf-8');

// The original custom parsecsv logic:
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      value += '"';
      index++; // Skip next quote
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(value.trim().replace(/^\uFEFF/, ''));
      value = '';
    } else if (char === '\n' && !inQuotes) {
      row.push(value.trim().replace(/^\uFEFF/, ''));
      if (row.some((cell) => cell !== '')) {
        rows.push(row);
      }
      row = [];
      value = '';
    } else if (char !== '\r') {
      value += char;
    }
  }

  if (value || row.length > 0) {
    row.push(value.trim().replace(/^\uFEFF/, ''));
    if (row.some((cell) => cell !== '')) {
      rows.push(row);
    }
  }

  return rows;
}

const rows = parseCsvRows(text);

console.log("Rows length:", rows.length);
if (rows.length > 0) {
  const firstRow = rows[0].map((cell) => cell.trim());
  const secondRow = rows[1]?.map((cell) => cell.trim()) || [];
  const firstCell = normalizeHeader(firstRow[0] || '');
  const secondCell = normalizeHeader(secondRow[0] || '');

  console.log("firstCell:", firstCell);
  console.log("secondCell:", secondCell);

  if (firstCell.includes('customer') && secondCell.includes('productcode')) {
    const dealerColumns = firstRow
      .map((dealer, index) => ({ dealer, index }))
      .filter(({ dealer, index }) => index > 0 && dealer && normalizeHeader(dealer) !== 'total');
    
    console.log("dealerColumns:", dealerColumns);
    
    const ordersByDealer = new Map();
    dealerColumns.forEach(({ dealer }, orderIndex) => {
      ordersByDealer.set(dealer, { dealer, items: [] });
    });

    let itemsProcessed = 0;

    rows.slice(2).forEach((row) => {
      const descriptor = row[0];
      if (!descriptor || normalizeHeader(descriptor).includes('grandtotal')) return;

      const parsedProduct = parseProductDescriptor(descriptor);

      dealerColumns.forEach(({ dealer, index }) => {
        const quantity = toQuantity(row[index]);
        if (!quantity) return;

        itemsProcessed++;
        
        ordersByDealer.get(dealer)?.items.push({
          name: parsedProduct.name,
          quantity,
          sapCode: parsedProduct.sapCode,
        });
      });
    });

    const parsedOrders = Array.from(ordersByDealer.values()).filter((order: any) => order.items.length > 0);
    console.log("parsedOrders length:", parsedOrders.length);
    console.log("itemsProcessed:", itemsProcessed);
    if(parsedOrders.length > 0) {
        console.log("Sample order:", JSON.stringify(parsedOrders[0], null, 2));
    }
  }
}
