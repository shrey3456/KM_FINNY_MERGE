import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export type ExportCell = string | number | null | undefined;

// Light palette shared by every PDF export: a pale blue-grey header with navy text instead of a
// solid dark-navy block, hairline grey rules and a barely-there zebra stripe — readable on screen
// and cheap on ink when printed.
const HEAD_FILL: [number, number, number] = [226, 232, 244];
const HEAD_TEXT: [number, number, number] = [0, 29, 110];
const STRIPE_FILL: [number, number, number] = [248, 250, 252];
const RULE: [number, number, number] = [221, 226, 234];

const NUMERIC_HEADER = /^(qty|pallets?|expected|actual|extra|total|sr\.? ?no\.?)$/i;

function clean(rows: ExportCell[][]): (string | number)[][] {
  return rows.map((r) => r.map((c) => (c == null ? "" : c)));
}

export function downloadCsv(filename: string, rows: ExportCell[][]) {
  const csv = "﻿" + clean(rows)
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Column widths follow the longest value in each column (capped), and the header row gets an
// auto-filter, so the sheet opens as a readable table rather than a block of cramped columns.
export function downloadExcel(filename: string, rows: ExportCell[][], sheetName = "Report") {
  const data = clean(rows);
  const sheet = XLSX.utils.aoa_to_sheet(data);
  const colCount = data[0]?.length ?? 0;
  sheet["!cols"] = Array.from({ length: colCount }, (_, i) => ({
    wch: Math.min(40, Math.max(8, ...data.map((r) => String(r[i] ?? "").length)) + 2),
  }));
  if (colCount > 0 && data.length > 0) {
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length - 1, c: colCount - 1 } }) };
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  XLSX.writeFile(book, filename);
}

export function downloadPdf(filename: string, title: string, rows: ExportCell[][], subtitle?: string) {
  const [header, ...body] = clean(rows);
  const doc = new jsPDF({ orientation: "landscape" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(...HEAD_TEXT);
  doc.text(title, margin, 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(110, 118, 130);
  doc.text(subtitle ?? "", margin, 19);
  doc.text(`Generated ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`, pageWidth - margin, 14, { align: "right" });

  const columnStyles: Record<number, { halign: "right" }> = {};
  (header ?? []).forEach((cell, i) => {
    if (NUMERIC_HEADER.test(String(cell).trim())) columnStyles[i] = { halign: "right" };
  });

  autoTable(doc, {
    head: [(header ?? []) as string[]],
    body: body as string[][],
    startY: 23,
    theme: "grid",
    margin: { left: margin, right: margin },
    styles: { fontSize: 7.5, cellPadding: 2, lineColor: RULE, lineWidth: 0.1, textColor: [40, 48, 60], overflow: "linebreak" },
    headStyles: { fillColor: HEAD_FILL, textColor: HEAD_TEXT, fontStyle: "bold", halign: "left" },
    alternateRowStyles: { fillColor: STRIPE_FILL },
    columnStyles,
  });

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    doc.setFontSize(8);
    doc.setTextColor(150, 156, 166);
    doc.text(`Page ${page} of ${pageCount}`, pageWidth - margin, pageHeight - 7, { align: "right" });
  }
  doc.save(filename);
}
