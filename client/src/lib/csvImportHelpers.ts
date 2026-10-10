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

// Picks the real header row (the one with the most filled cells in the first 15 — an export with a report title
// above the headers would otherwise hand the title row over) and returns every later line keyed by header.
export async function parseCsvRaw(file: File): Promise<{ name: string; headers: string[]; rows: Record<string, string>[] } | null> {
  const rawRows = await readFileAsGrid(file);
  if (rawRows.length === 0) return null;
  let headerRowIdx = 0;
  let maxCols = 0;
  for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
    const nonEmpty = rawRows[i].filter((c) => c.trim() !== "").length;
    if (nonEmpty > maxCols) { maxCols = nonEmpty; headerRowIdx = i; }
  }
  const headers = rawRows[headerRowIdx].map((h) => cleanHeader(h)).filter((h) => h !== "");
  if (headers.length === 0) return null;
  const rows = rawRows.slice(headerRowIdx + 1).map((row) => {
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
