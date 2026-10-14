import type jsPDF from "jspdf";
import logoUrl from "@assets/logo_og_1756804412382.jpeg";

// The shared look of every PDF export: the Krupa Marketing logo and name on a white header with a navy rule,
// the report title / scope underneath, searchable PDF properties, and the total row picked out in green.

export const NAVY: [number, number, number] = [0, 29, 110];
const GREY: [number, number, number] = [110, 118, 130];
const TOTAL_FILL: [number, number, number] = [220, 243, 228];
const TOTAL_TEXT: [number, number, number] = [21, 101, 52];

const COMPANY = "Krupa Marketing";

// The logo is a 3000px photo — shrunk once to a small JPEG so each PDF stays light. Loaded as soon as this
// module is imported, so by the time someone clicks Export it is already in hand (the export stays synchronous).
let logoData: string | null = null;
let logoLoading: Promise<string | null> | null = null;

export function loadPdfLogo(): Promise<string | null> {
  if (logoData) return Promise.resolve(logoData);
  if (!logoLoading) {
    logoLoading = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const size = 240;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve(null);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, 0, 0, size, size);
          logoData = canvas.toDataURL("image/jpeg", 0.85);
          resolve(logoData);
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = logoUrl;
    });
  }
  return logoLoading;
}
if (typeof window !== "undefined") void loadPdfLogo();

// Draws the header on the first page and returns the y to start the table at.
export function drawPdfHeader(
  doc: jsPDF,
  opts: { title: string; subtitle?: string; margin: number; generated?: string },
): number {
  const pageWidth = doc.internal.pageSize.getWidth();
  const { margin } = opts;
  const generated = opts.generated ?? new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const logoSize = 16;
  const top = 7;

  let textX = margin;
  if (logoData) {
    doc.addImage(logoData, "JPEG", margin, top, logoSize, logoSize, undefined, "FAST");
    textX = margin + logoSize + 4;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...GREY);
  doc.text(COMPANY.toUpperCase(), textX, top + 3.5);

  doc.setFontSize(14);
  doc.setTextColor(...NAVY);
  doc.text(opts.title, textX, top + 10);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...GREY);
  if (opts.subtitle) doc.text(opts.subtitle, textX, top + 15, { maxWidth: pageWidth - textX - margin - 55 });
  doc.text(`Generated ${generated}`, pageWidth - margin, top + 3.5, { align: "right" });

  const ruleY = top + logoSize + 3;
  doc.setDrawColor(...NAVY);
  doc.setLineWidth(0.6);
  doc.line(margin, ruleY, pageWidth - margin, ruleY);
  return ruleY + 4;
}

// Document properties — what a PDF viewer, a search index or a file manager reads: a real title, who made it,
// what it is about. The file name itself should be descriptive too (callers already build one from the report).
export function setPdfProperties(doc: jsPDF, title: string, subtitle?: string) {
  const words = `${title} ${subtitle ?? ""}`.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 2);
  doc.setProperties({
    title: `${title} | ${COMPANY}`,
    subject: subtitle ? `${title} — ${subtitle}` : title,
    author: COMPANY,
    creator: "KM Finny",
    keywords: Array.from(new Set([COMPANY, "report", "stock", "scan", ...words])).slice(0, 20).join(", "),
  });
  try { doc.setLanguage("en-US"); } catch { /* older jsPDF builds */ }
}

// A "Total" / "Grand Total" row — the label sits in one of the first cells.
export const isTotalRow = (row: Array<string | number | null | undefined>) =>
  row.slice(0, 3).some((c) => /^(grand\s+)?total\b/i.test(String(c ?? "").trim()));

// autoTable hook: totals rows get a green fill, dark green bold text.
export function greenTotalRow(data: { section: string; row: { raw: unknown; index: number }; cell: { styles: Record<string, any> } }) {
  if (data.section !== "body") return;
  const raw = data.row.raw;
  const cells = Array.isArray(raw) ? raw : Object.values((raw as Record<string, unknown>) ?? {});
  if (!isTotalRow(cells as Array<string | number | null | undefined>)) return;
  data.cell.styles.fillColor = TOTAL_FILL;
  data.cell.styles.textColor = TOTAL_TEXT;
  data.cell.styles.fontStyle = "bold";
}

// Set to false to switch the diagonal "KRUPA MARKETING" watermark off in every PDF.
export const PDF_WATERMARK = true;

// A faint diagonal company name across the middle of the page. Drawn last, at low opacity, so the table stays
// readable underneath it.
function drawWatermark(doc: jsPDF) {
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  const angle = (Math.atan2(h, w) * 180) / Math.PI * 0.75; // follows the page diagonal, a little flatter
  doc.saveGraphicsState();
  doc.setGState(new (doc as any).GState({ opacity: 0.07 }));
  doc.setFont("helvetica", "bold");
  doc.setFontSize(Math.round(w / 6));
  doc.setTextColor(...NAVY);
  doc.text(COMPANY.toUpperCase(), w / 2, h / 2, { align: "center", angle, baseline: "middle" });
  doc.restoreGraphicsState();
}

// Footer on every page: the company on the left, page x of y on the right (and the watermark, when on).
export function drawPdfFooter(doc: jsPDF, margin: number) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    if (PDF_WATERMARK) drawWatermark(doc);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(150, 156, 166);
    doc.text(`${COMPANY} — Confidential`, margin, pageHeight - 7);
    doc.text(`Page ${page} of ${pageCount}`, pageWidth - margin, pageHeight - 7, { align: "right" });
  }
}
