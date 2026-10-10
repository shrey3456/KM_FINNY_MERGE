import Papa from "papaparse";
import * as XLSX from "xlsx";

// CSV / Excel reading and column matching for the Settings imports (Manual Sales). Same behaviour as the
// Opening Stock import in Settings.tsx and Order Import: the real header row is found, headers are cleaned,
// columns are auto-matched, and the person can re-point any field in the mapping dialog.

export const CSV_SKIP = "__skip__";

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

// Strips a BOM and any other non-ASCII byte an Excel "CSV UTF-16"/"CSV (Macintosh)" export leaves in a header.
function cleanHeader(h: string): string {
  return h.replace(/^﻿/, "").replace(/[^\x20-\x7E]/g, "").trim();
}

export function matchColumn(headers: string[], candidates: string[]): string | null {
  const normalized = headers.map((h) => ({ raw: h, norm: normHeader(h) }));
  for (const c of candidates) {
    const exact = normalized.find((h) => h.norm === c);
    if (exact) return exact.raw;
  }
  for (const c of candidates) {
    const partial = normalized.find((h) => h.norm.includes(c));
    if (partial) return partial.raw;
  }
  return null;
}

// A .csv as text rows, or a real .xlsx/.xls workbook's first sheet — the same string[][] either way. Reading a
// native workbook directly keeps a long barcode's exact digits (Excel's own CSV export is what rounds them).
function readFileAsGrid(file: File): Promise<string[][]> {
  if (/\.xlsx?$/i.test(file.name)) {
    return file.arrayBuffer().then((buf) => {
      const workbook = XLSX.read(buf, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) return [];
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: true });
      return aoa.map((row) => row.map((cell) => (cell == null ? "" : String(cell))));
    });
  }
  return new Promise((resolve) => {
    Papa.parse<string[]>(file, {
      header: false,
      skipEmptyLines: true,
      delimiter: "",
      encoding: "UTF-8",
      complete: (result) => resolve(result.data as string[][]),
      error: () => resolve([]),
    });
  });
}

const looksNumeric = (c: string) => /^[\d.,\s-]+$/.test(c.trim());
const colLetter = (i: number) => { let n = i; let out = ""; do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0); return out; };

// Finds the header and keys every later line by it. Built for real exports, which are not tidy:
//  - the header row is the one with the most TEXT cells in the first 15 lines (a data row full of codes and numbers
//    can have more filled cells than a header with blank cells at its edges, so cell count alone is not used);
//  - a header cell left blank keeps its place and is named "Column A", "Column B"… — dropping it would shift every
//    other column one to the left;
//  - when the line right under the header holds only a few text cells (a "TOTAL SALES" title under a blank header
//    cell, or "Number" under "Order"), they complete the header and that line is not data.
export async function parseCsvRaw(file: File): Promise<{ name: string; headers: string[]; rows: Record<string, string>[] } | null> {
  const rawRows = await readFileAsGrid(file);
  if (rawRows.length === 0) return null;
  let headerRowIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
    const score = rawRows[i].filter((c) => c.trim() !== "" && !looksNumeric(c)).length;
    if (score > bestScore) { bestScore = score; headerRowIdx = i; }
  }
  const headerRow = rawRows[headerRowIdx].map((h) => cleanHeader(h));
  if (headerRow.every((h) => h === "")) return null;

  let firstDataIdx = headerRowIdx + 1;
  const next = rawRows[firstDataIdx];
  if (next) {
    const filled = next.map((c, i) => ({ c: cleanHeader(c), i })).filter((x) => x.c !== "");
    const afterNext = rawRows[firstDataIdx + 1];
    if (filled.length > 0 && filled.length <= 3 && afterNext
      && filled.every((x) => !looksNumeric(x.c) && (afterNext[x.i] ?? "").trim() !== "")) {
      // under a blank header cell the text is the header; under a filled one it is its second line ("Order" / "Number")
      filled.forEach((x) => { headerRow[x.i] = ((headerRow[x.i] ?? "") + " " + x.c).trim(); });
      firstDataIdx++;
    }
  }

  const width = Math.max(headerRow.length, ...rawRows.slice(firstDataIdx, firstDataIdx + 200).map((r) => r.length));
  const seen = new Map<string, number>();
  const headers: string[] = [];
  for (let i = 0; i < width; i++) {
    let name = headerRow[i] ? headerRow[i] : "Column " + colLetter(i);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = name + " (" + n + ")";
    headers.push(name);
  }
  const rows = rawRows.slice(firstDataIdx)
    .filter((row) => row.some((c) => c.trim() !== ""))
    .map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
      return obj;
    });
  return { name: file.name, headers, rows };
}

// parseFloat, not strip-the-non-digits: "200.00" must stay 200, not become 20000. Commas are thousands separators.
export function parseQty(raw: string): number {
  const n = parseFloat((raw ?? "0").replace(/,/g, "").trim());
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// Excel damages a barcode cell in a few ways a plain trim lets through: ="8906010500375" (unwrapped here),
// 8.90601E+12 (rounded for good — rejected), and a trailing "Total" row with no digits at all (rejected).
export function cleanBarcodeCell(raw: string): { value: string; rejected: "scientific" | "not-a-barcode" | null } {
  const trimmed = (raw ?? "").trim();
  const unwrapped = /^="(.*)"$/.exec(trimmed)?.[1]?.trim() ?? trimmed;
  if (/^\d+(\.\d+)?E\+\d+$/i.test(unwrapped)) return { value: unwrapped, rejected: "scientific" };
  if (unwrapped && !/\d/.test(unwrapped)) return { value: unwrapped, rejected: "not-a-barcode" };
  return { value: unwrapped, rejected: null };
}
