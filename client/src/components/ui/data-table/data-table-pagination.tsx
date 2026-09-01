import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Numbered page-button list with ellipsis gaps around the current page — same generator Overall
// Stock's mobile card list originally had to build for itself (its own pager sits below the
// table, which is hidden on a phone), moved here so every DataTable-backed page gets the same
// pagination UI instead of each screen inventing its own.
export function buildPageList(pageIndex: number, pageCount: number, window = 1): Array<number | "gap"> {
  const maxWithoutGaps = window * 2 + 5;
  if (pageCount <= maxWithoutGaps) return Array.from({ length: pageCount }, (_, i) => i);

  const last = pageCount - 1;
  // Near either end the window would be clipped by the edge, leaving a stubby "1 2 … 442".
  // Extend it inward so the run of numbers stays the same length wherever you are.
  let from: number;
  let to: number;
  if (pageIndex <= window) {
    from = 1;
    to = Math.min(last - 1, window * 2);
  } else if (pageIndex >= last - window) {
    from = Math.max(1, last - window * 2);
    to = last - 1;
  } else {
    from = pageIndex - window;
    to = pageIndex + window;
  }

  const pages: Array<number | "gap"> = [0];
  // A gap standing in for a single page takes as much room as the page itself, so only use one
  // where at least two pages are hidden — otherwise show that page.
  if (from > 2) pages.push("gap");
  else if (from === 2) pages.push(1);
  for (let i = from; i <= to; i++) pages.push(i);
  if (to < last - 2) pages.push("gap");
  else if (to === last - 2) pages.push(last - 1);
  pages.push(last);
  return pages;
}

interface DataTablePaginationProps {
  pageIndex: number;
  pageCount: number;
  pageSize: number;
  pageSizeOptions: number[];
  totalRows: number;
  onPageIndexChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

export function DataTablePagination({
  pageIndex,
  pageCount,
  pageSize,
  pageSizeOptions,
  totalRows,
  onPageIndexChange,
  onPageSizeChange,
}: DataTablePaginationProps) {
  const canPreviousPage = pageIndex > 0;
  const canNextPage = pageIndex < pageCount - 1;
  const startRow = totalRows === 0 ? 0 : pageIndex * pageSize + 1;
  const endRow = Math.min((pageIndex + 1) * pageSize, totalRows);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-3">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        Showing {startRow} to {endRow} of {totalRows} entries
      </span>

      <nav className="flex flex-wrap items-center justify-center gap-1" aria-label="Pagination">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => onPageIndexChange(Math.max(0, pageIndex - 1))}
          disabled={!canPreviousPage}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        {buildPageList(pageIndex, pageCount).map((pg, i) =>
          pg === "gap" ? (
            <span key={`gap-${i}`} aria-hidden className="select-none px-1 text-sm text-gray-400">…</span>
          ) : (
            <Button
              key={pg}
              variant={pg === pageIndex ? "default" : "outline"}
              size="sm"
              className={`h-8 min-w-8 px-2 tabular-nums ${pg === pageIndex ? "bg-[#001d6e] text-white hover:bg-[#00154b]" : ""}`}
              onClick={() => onPageIndexChange(pg)}
              aria-label={`Page ${pg + 1}`}
              aria-current={pg === pageIndex ? "page" : undefined}
            >
              {pg + 1}
            </Button>
          ),
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => onPageIndexChange(Math.min(pageCount - 1, pageIndex + 1))}
          disabled={!canNextPage}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </nav>

      <div className="flex items-center gap-1">
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          Show:
        </span>
        <select
          className="h-7 rounded border bg-background px-1 text-xs"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          aria-label="Rows per page"
        >
          {pageSizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
