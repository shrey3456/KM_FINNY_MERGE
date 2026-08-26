import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Which page numbers a pager should offer, given the current page and how many there are — all of
 * them when they fit, otherwise the first, the last, a window around the current page, and "gap"
 * where the run is broken. Both indexes are 0-based.
 *
 * Exported because several pages build their own pagers (server-driven paging, and the mobile card
 * lists that stand in for a table too wide for a phone) and every one of them should offer the
 * same pages this component does.
 */
export function buildPageList(
  pageIndex: number,
  pageCount: number,
  window = 1,
): Array<number | "gap"> {
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

/**
 * The app-wide pager: a numbered run rather than a bare "Page 1 of 442", so you can see where you
 * are, step a page at a time, or jump straight to the end. Pages that build their own pager
 * (server-driven paging, mobile card lists) reproduce this look with `buildPageList` above.
 */
export function DataTablePaginationNav({
  pageIndex,
  pageCount,
  onPageIndexChange,
  className = "",
}: {
  pageIndex: number;
  pageCount: number;
  onPageIndexChange: (pageIndex: number) => void;
  className?: string;
}) {
  return (
    <nav
      className={`flex flex-wrap items-center justify-center gap-1 ${className}`}
      aria-label="Pagination"
    >
      <Button
        variant="outline"
        size="sm"
        className="h-8 w-8 p-0"
        onClick={() => onPageIndexChange(Math.max(0, pageIndex - 1))}
        disabled={pageIndex <= 0}
        aria-label="Previous page"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      {buildPageList(pageIndex, pageCount).map((p, i) =>
        p === "gap" ? (
          // Not a button: it stands for pages that aren't offered, so it mustn't look clickable.
          // aria-hidden keeps it out of the screen-reader page list.
          <span
            key={`gap-${i}`}
            aria-hidden
            className="select-none px-1 text-sm text-muted-foreground"
          >
            …
          </span>
        ) : (
          <Button
            key={p}
            variant={p === pageIndex ? "default" : "outline"}
            size="sm"
            className={`h-8 min-w-8 px-2 tabular-nums ${
              p === pageIndex ? "bg-[#001d6e] text-white hover:bg-[#00154b]" : ""
            }`}
            onClick={() => onPageIndexChange(p)}
            aria-label={`Page ${p + 1}`}
            aria-current={p === pageIndex ? "page" : undefined}
          >
            {p + 1}
          </Button>
        ),
      )}

      <Button
        variant="outline"
        size="sm"
        className="h-8 w-8 p-0"
        onClick={() => onPageIndexChange(Math.min(pageCount - 1, pageIndex + 1))}
        disabled={pageIndex >= pageCount - 1}
        aria-label="Next page"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </nav>
  );
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
  const startRow = totalRows === 0 ? 0 : pageIndex * pageSize + 1;
  const endRow = Math.min((pageIndex + 1) * pageSize, totalRows);

  return (
    <div className="border-t px-3 py-3">
      {/* Three tracks so the pager sits in the TRUE centre of the row — with a plain
          justify-between it would only be centred when the left-hand text happened to match the
          empty right-hand side. The outer tracks share the leftover space evenly. */}
      <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <div className="flex items-center gap-3">
          <span className="whitespace-nowrap text-sm text-muted-foreground">
            Showing {startRow.toLocaleString()} to {endRow.toLocaleString()} of{" "}
            {totalRows.toLocaleString()} entries
          </span>
          {/* Rows-per-page sits with the paging it actually affects. */}
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="whitespace-nowrap">Rows</span>
            <select
              className="h-7 rounded-md border bg-background px-1.5 text-sm"
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
          </label>
        </div>

        <DataTablePaginationNav
          pageIndex={pageIndex}
          pageCount={pageCount}
          onPageIndexChange={onPageIndexChange}
        />

        {/* Balances the left-hand track so the pager above lands dead centre. */}
        <div className="hidden sm:block" />
      </div>
    </div>
  );
}
