import { Button } from "@/components/ui/button";
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

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
    <div className="flex flex-col gap-3 border-t px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center justify-between gap-2 sm:justify-start">
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          Showing {startRow} to {endRow} of {totalRows} entries
        </span>
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

      <div className="flex items-center justify-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => onPageIndexChange(0)}
          disabled={!canPreviousPage}
        >
          <span className="sr-only">Go to first page</span>
          <ChevronFirst className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => onPageIndexChange(Math.max(0, pageIndex - 1))}
          disabled={!canPreviousPage}
        >
          <span className="sr-only">Go to previous page</span>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="px-2 text-xs whitespace-nowrap text-muted-foreground">
          Page {pageCount === 0 ? 0 : pageIndex + 1} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => onPageIndexChange(Math.min(pageCount - 1, pageIndex + 1))}
          disabled={!canNextPage}
        >
          <span className="sr-only">Go to next page</span>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => onPageIndexChange(pageCount - 1)}
          disabled={!canNextPage}
        >
          <span className="sr-only">Go to last page</span>
          <ChevronLast className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
