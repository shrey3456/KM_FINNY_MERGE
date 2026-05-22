import { readFileSync } from 'fs';

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseProductDescriptor(descriptor: string) {
  const clean = descriptor.trim();
  const match = clean.match(/^(\d+)\s*-\s*(.+)$/);
  if (match) return { sapCode: match[1], name: match[2].trim() };
  return { sapCode: clean.match(/\d{5,}/)?.[0], name: clean || 'Imported Product' };
}

function toQuantity(value: string | undefined) {
  const numericValue = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(numericValue) && numericValue > 0 ? Math.round(numericValue) : 0;
}

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
      index++;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(value.trim().replace(/^\uFEFF/, ''));
      value = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index++;
      row.push(value.trim().replace(/^\uFEFF/, ''));
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      value = '';
      continue;
    }
    value += char;
  }
  if (value || row.length > 0) {
    row.push(value.trim().replace(/^\uFEFF/, ''));
    if (row.some((cell) => cell !== '')) rows.push(row);
  }
  return rows;
}

const text = readFileSync('attached_assets/main order csv.csv', 'utf-8');
const rows = parseCsvRows(text);

console.log('Total rows:', rows.length);
if (rows.length > 0) {
  const firstRow = rows[0].map(c => c.trim());
  const secondRow = rows[1]?.map(c => c.trim()) || [];
  
  console.log('First Cell:', normalizeHeader(firstRow[0] || ''));
  console.log('Second Cell:', normalizeHeader(secondRow[0] || ''));

  const productHeaderRowIndex = rows.findIndex((row) =>
    row.some((cell) => normalizeHeader(cell).includes('productcode')),
  );
  
  const customerHeaderRowIndex = rows.findIndex((row) =>
    row.some((cell) => normalizeHeader(cell).includes('customer') || normalizeHeader(cell) === 'customer'),
  );

  console.log('productHeaderRowIndex:', productHeaderRowIndex);
  console.log('customerHeaderRowIndex:', customerHeaderRowIndex);
}
