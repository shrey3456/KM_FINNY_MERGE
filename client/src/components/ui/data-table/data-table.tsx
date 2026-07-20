import { Fragment, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from "lucide-react";
import { DataTablePagination } from "./data-table-pagination";
import { DataTableColumnToggle } from "./data-table-column-toggle";
import type {
  DataTableColumn,
  DataTableEmptyState,
  DataTableFooterContext,
  DataTableSortDirection,
  DataTableSortState,
} from "./types";

function cellText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (value instanceof Date) return value.toLocaleString();
  return String(value);
}

/**
 * Totals-row cell for one column, over every filtered row (not just the current page).
 *
 * Order of precedence: an explicit `total` wins; `totalable: false` blanks the cell; otherwise the
 * column auto-sums when its accessor yields numbers. Text columns stay blank rather than showing a
 * meaningless 0. Decimals are preserved to the widest precision seen in the column, so a pallet
 * column reading 1.25 / 2.00 totals as 3.25 rather than 3.
 */
function columnTotal<TData>(col: DataTableColumn<TData>, rows: TData[]): ReactNode {
  if (col.total) return col.total(rows);
  if (col.totalable === false || !col.accessor) return null;

  let sum = 0;
  let seen = 0;
  let decimals = 0;
  for (const row of rows) {
    const raw = col.accessor(row);
    // Accept numeric strings ("12", "3.50") as well as numbers; ignore blanks and non-numerics.
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n)) continue;
    sum += n;
    seen += 1;
    const dot = String(raw).indexOf(".");
    if (dot >= 0) decimals = Math.max(decimals, String(raw).length - dot - 1);
  }
  if (seen === 0) return null;
  return sum.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function getCellValue<TData>(row: TData, column: DataTableColumn<TData>): unknown {
  if (column.accessor) return column.accessor(row);
  return (row as Record<string, unknown>)[column.id];
}

function renderEmptyState(state: ReactNode | DataTableEmptyState | undefined, fallback: string) {
  if (!state) {
    return <div className="py-10 text-center text-sm text-muted-foreground">{fallback}</div>;
  }
  if (typeof state !== "object" || !("title" in state)) {
    return <div className="py-10 text-center text-sm text-muted-foreground">{state as ReactNode}</div>;
  }
  const { icon: Icon, title, description, action } = state as DataTableEmptyState;
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      {Icon && <Icon className="h-8 w-8 text-muted-foreground/50" />}
      <div className="text-sm font-medium text-muted-foreground">{title}</div>
      {description && <div className="text-xs text-muted-foreground">{description}</div>}
      {action}
    </div>
  );
}

interface DataTableProps<TData> {
  columns: DataTableColumn<TData>[];
  data: TData[];
  getRowId: (row: TData, index: number) => string;

  isLoading?: boolean;
  loadingLabel?: string;

  emptyState?: ReactNode | DataTableEmptyState;
  noResultsState?: ReactNode | DataTableEmptyState;
  hasActiveFilters?: boolean;

  enableSearch?: boolean;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchableColumnIds?: string[];

  sortMode?: "none" | "client" | "external";
  sortState?: DataTableSortState | null;
  onSortingChange?: (state: DataTableSortState | null) => void;
  onSortColumnClick?: (columnId: string) => void;

  paginationMode?: "none" | "client";
  pageIndex?: number;
  onPageIndexChange?: (pageIndex: number) => void;
  pageSize?: number;
  onPageSizeChange?: (pageSize: number) => void;
  defaultPageSize?: number;
  pageSizeOptions?: number[];

  enableColumnVisibility?: boolean;
  /** Controlled visible-column ids. When set, the consumer owns the toggle UI (e.g. render `DataTableColumnToggle` elsewhere) and DataTable won't render its own button. */
  columnVisibility?: Set<string>;
  onColumnVisibilityChange?: (ids: Set<string>) => void;

  onRowClick?: (row: TData) => void;
  isRowClickable?: (row: TData) => boolean;

  enableRowSelection?: boolean;
  selectedRowIds?: string[];
  onSelectedRowIdsChange?: (ids: string[]) => void;
  isRowSelectable?: (row: TData) => boolean;
  renderBulkActions?: (selectedRows: TData[]) => ReactNode;

  renderExpandedRow?: (row: TData) => ReactNode;
  isRowExpandable?: (row: TData) => boolean;
  expandedRowId?: string | null;

  /**
   * Renders inside the table as a native <tfoot>, so cells align with the
   * colgroup-driven column widths. Return a `TableFooter`/`tfoot` element.
   * When provided, the built-in DataTablePagination bar is not rendered —
   * the consumer owns pagination UI via the context's setPageIndex/setPageSize.
   */
  renderFooter?: (ctx: DataTableFooterContext) => ReactNode;

  enableColumnResizing?: boolean;
  isStickyHeader?: boolean;
  stickyColumnId?: string;
  maxHeight?: string;
  headerClassName?: string;
  showMobileSwipeHint?: boolean;
  enableZebraStripes?: boolean;
  /**
   * Append a totals row under the last data row. Totals cover every filtered row, not just the
   * current page, so they don't change as you page through. Columns auto-sum when their accessor
   * yields numbers; override per column with `total`, or opt out with `totalable: false`.
   */
  enableTotalsRow?: boolean;
  /** Label placed in the totals row's first cell. */
  totalsLabel?: string;
  /** Per-row classes (e.g. status tints). Wins over enableZebraStripes for rows it styles. */
  rowClassName?: (row: TData, rowIndex: number) => string | undefined;

  className?: string;
  /** Classes for the bordered box wrapping the table + pagination. Pass e.g. "border-0 rounded-none" to sit flush inside a Card. */
  containerClassName?: string;
}

export function DataTable<TData>({
  columns,
  data,
  getRowId,
  isLoading = false,
  loadingLabel = "Loading...",
  emptyState,
  noResultsState,
  hasActiveFilters,
  enableSearch = false,
  searchPlaceholder = "Search...",
  searchValue,
  onSearchChange,
  searchableColumnIds,
  sortMode = "none",
  sortState,
  onSortingChange,
  onSortColumnClick,
  paginationMode = "none",
  pageIndex,
  onPageIndexChange,
  pageSize,
  onPageSizeChange,
  defaultPageSize = 10,
  pageSizeOptions = [10, 25, 50, 100],
  enableColumnVisibility = false,
  columnVisibility,
  onColumnVisibilityChange,
  onRowClick,
  isRowClickable,
  enableRowSelection = false,
  selectedRowIds,
  onSelectedRowIdsChange,
  isRowSelectable,
  renderBulkActions,
  renderExpandedRow,
  isRowExpandable,
  expandedRowId = null,
  renderFooter,
  enableColumnResizing = false,
  isStickyHeader = false,
  stickyColumnId,
  maxHeight,
  headerClassName,
  showMobileSwipeHint,
  enableZebraStripes = false,
  enableTotalsRow = false,
  totalsLabel = "Total",
  rowClassName,
  className,
  containerClassName,
}: DataTableProps<TData>) {
  const [internalSearch, setInternalSearch] = useState("");
  const [internalSort, setInternalSort] = useState<DataTableSortState | null>(null);
  const [internalPageIndex, setInternalPageIndex] = useState(0);
  const [internalPageSize, setInternalPageSize] = useState(defaultPageSize);
  const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>([]);
  const [internalVisibleIds, setInternalVisibleIds] = useState<Set<string>>(
    () => new Set(columns.filter((c) => !c.isHiddenByDefault).map((c) => c.id)),
  );
  const [colWidths, setColWidths] = useState<Record<string, number>>({});

  const search = searchValue ?? internalSearch;
  const setSearch = (value: string) => (onSearchChange ? onSearchChange(value) : setInternalSearch(value));

  const activeSort = sortMode === "client" ? internalSort : sortState ?? null;

  const selectedSet = new Set(selectedRowIds ?? internalSelectedIds);
  const setSelected = (ids: string[]) =>
    onSelectedRowIdsChange ? onSelectedRowIdsChange(ids) : setInternalSelectedIds(ids);

  const isVisibilityControlled = columnVisibility !== undefined;
  const activeVisibleIds = isVisibilityControlled ? columnVisibility! : internalVisibleIds;

  const visibleColumnIds = enableColumnVisibility
    ? new Set([
        ...Array.from(activeVisibleIds),
        ...columns.filter((c) => c.hideable === false).map((c) => c.id),
      ])
    : new Set(columns.map((c) => c.id));
  const visibleColumns = columns.filter((c) => visibleColumnIds.has(c.id));

  const rowsWithIds = useMemo(
    () => data.map((row, index) => ({ row, id: getRowId(row, index) })),
    [data, getRowId],
  );

  const searchableIds = searchableColumnIds ?? visibleColumns.map((c) => c.id);
  let processed = rowsWithIds;
  if (enableSearch && search.trim()) {
    const q = search.trim().toLowerCase();
    processed = processed.filter(({ row }) =>
      searchableIds.some((id) => {
        const col = columns.find((c) => c.id === id);
        if (!col) return false;
        return cellText(getCellValue(row, col)).toLowerCase().includes(q);
      }),
    );
  }

  let sortedRows = processed;
  if (sortMode === "client" && activeSort) {
    const col = columns.find((c) => c.id === activeSort.columnId);
    sortedRows = [...processed].sort((a, b) => {
      const va = col ? getCellValue(a.row, col) : undefined;
      const vb = col ? getCellValue(b.row, col) : undefined;
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return activeSort.direction === "asc" ? -1 : 1;
      if (va > vb) return activeSort.direction === "asc" ? 1 : -1;
      return 0;
    });
  }

  const allRows = sortedRows;
  // allRows holds { row, id } wrappers; column accessors expect the bare TData, so unwrap for totals.
  const totalsRows = allRows.map((r) => r.row);

  const pSize = paginationMode === "client" ? pageSize ?? internalPageSize : Math.max(allRows.length, 1);
  const pageCount = paginationMode === "client" ? Math.max(1, Math.ceil(allRows.length / pSize)) : 1;
  const rawPageIndex = paginationMode === "client" ? pageIndex ?? internalPageIndex : 0;
  const safePageIndex = Math.min(Math.max(rawPageIndex, 0), pageCount - 1);

  const pageRows = paginationMode === "client"
    ? allRows.slice(safePageIndex * pSize, safePageIndex * pSize + pSize)
    : allRows;

  const setPageIndex = (next: number) =>
    onPageIndexChange ? onPageIndexChange(next) : setInternalPageIndex(next);
  const setPageSize = (next: number) => {
    if (onPageSizeChange) onPageSizeChange(next);
    else setInternalPageSize(next);
    setPageIndex(0);
  };

  const selectableAllRows = isRowSelectable ? allRows.filter((r) => isRowSelectable(r.row)) : allRows;
  const allSelected = selectableAllRows.length > 0 && selectableAllRows.every((r) => selectedSet.has(r.id));

  const toggleSelectAll = () => {
    const ids = selectableAllRows.map((r) => r.id);
    const next = new Set(selectedSet);
    if (allSelected) {
      ids.forEach((id) => next.delete(id));
    } else {
      ids.forEach((id) => next.add(id));
    }
    setSelected(Array.from(next));
  };

  const toggleRowSelected = (id: string) => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(Array.from(next));
  };

  const selectedRows = allRows.filter((r) => selectedSet.has(r.id)).map((r) => r.row);

  const handleSortClick = (col: DataTableColumn<TData>) => {
    if (!col.sortable) return;
    if (sortMode === "external") {
      onSortColumnClick?.(col.id);
      return;
    }
    if (sortMode === "client") {
      let next: DataTableSortState | null;
      if (!internalSort || internalSort.columnId !== col.id) {
        next = { columnId: col.id, direction: "asc" };
      } else if (internalSort.direction === "asc") {
        next = { columnId: col.id, direction: "desc" as DataTableSortDirection };
      } else {
        next = null;
      }
      setInternalSort(next);
      onSortingChange?.(next);
    }
  };

  const toggleColumnVisibility = (id: string) => {
    if (isVisibilityControlled) {
      const next = new Set(columnVisibility);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onColumnVisibilityChange?.(next);
      return;
    }
    setInternalVisibleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setAllColumnsVisible = (visible: boolean) => {
    const next = visible ? new Set(columns.map((c) => c.id)) : new Set<string>();
    if (isVisibilityControlled) onColumnVisibilityChange?.(next);
    else setInternalVisibleIds(next);
  };

  const getColWidth = (col: DataTableColumn<TData>) => colWidths[col.id] ?? col.width ?? 140;

  const startResize = (e: React.MouseEvent, col: DataTableColumn<TData>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = getColWidth(col);
    const minWidth = col.minWidth ?? 60;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      setColWidths((prev) => ({ ...prev, [col.id]: Math.max(minWidth, startWidth + delta) }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const computedHasActiveFilters = hasActiveFilters ?? (enableSearch && search.trim() !== "");
  const computedShowSwipeHint = showMobileSwipeHint ?? (data.length > 0 && visibleColumns.length > 3);

  const totalColSpan = visibleColumns.length + (enableRowSelection ? 1 : 0);
  const totalTableWidth =
    (enableRowSelection ? 40 : 0) + visibleColumns.reduce((sum, col) => sum + getColWidth(col), 0);

  const footerCtx: DataTableFooterContext = {
    pageIndex: safePageIndex,
    pageCount,
    pageSize: pSize,
    totalRows: allRows.length,
    columnCount: totalColSpan,
    setPageIndex,
    setPageSize,
  };

  return (
    <div className={cn("space-y-3", className)}>
      {(enableSearch || (enableColumnVisibility && !isVisibilityControlled)) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {enableSearch && (
            <div className="relative w-full sm:max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 pr-8"
              />
              {search && (
                <button
                  type="button"
                  className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                  onClick={() => setSearch("")}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          {enableColumnVisibility && !isVisibilityControlled && (
            <DataTableColumnToggle
              columns={columns}
              visibleColumnIds={visibleColumnIds}
              onToggleColumn={toggleColumnVisibility}
              onSetAll={setAllColumnsVisible}
            />
          )}
        </div>
      )}

      {selectedRows.length > 0 && renderBulkActions && (
        <div className="flex items-center gap-2">{renderBulkActions(selectedRows)}</div>
      )}

      {isLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">{loadingLabel}</div>
      ) : allRows.length === 0 ? (
        renderEmptyState(
          computedHasActiveFilters ? noResultsState ?? emptyState : emptyState,
          computedHasActiveFilters ? "No results match your filters." : "No data found.",
        )
      ) : (
        <div className={cn("rounded-md border", containerClassName)}>
          {computedShowSwipeHint && (
            <div className="flex items-center justify-center gap-1.5 border-b bg-muted/40 py-1 sm:hidden">
              <span className="text-[10px] font-medium text-muted-foreground">
                ← Swipe left / right to see all columns →
              </span>
            </div>
          )}
          <div
            className="w-full overflow-x-auto"
            style={{
              overflowY: isStickyHeader ? "auto" : undefined,
              maxHeight: isStickyHeader ? maxHeight : undefined,
              WebkitOverflowScrolling: "touch",
            }}
          >
            <table
              className="border-collapse"
              style={{ width: "100%", minWidth: totalTableWidth, tableLayout: "fixed" }}
            >
              <colgroup>
                {enableRowSelection && <col style={{ width: `${(40 / totalTableWidth) * 100}%` }} />}
                {visibleColumns.map((col) => (
                  <col key={col.id} style={{ width: `${(getColWidth(col) / totalTableWidth) * 100}%` }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {enableRowSelection && (
                    <th
                      className={cn(
                        "border-b border-r bg-background px-2 py-2 align-middle sm:px-2.5 sm:py-2.5",
                        isStickyHeader && "sticky top-0 z-20",
                        headerClassName,
                      )}
                    >
                      <div className="flex items-center justify-center">
                        <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="Select all" />
                      </div>
                    </th>
                  )}
                  {visibleColumns.map((col) => {
                    const isPinned = isStickyHeader && stickyColumnId === col.id;
                    const isSorted = activeSort?.columnId === col.id;
                    return (
                      <th
                        key={col.id}
                        className={cn(
                          "relative whitespace-nowrap border-b border-r bg-background px-2 py-2 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:px-2.5 sm:py-2.5 sm:text-[11px]",
                          isStickyHeader && "sticky top-0 z-10 bg-background",
                          isPinned && "left-0 z-20 shadow-[2px_0_4px_-1px_rgba(0,0,0,0.08)]",
                          col.sortable && "cursor-pointer select-none",
                          col.align === "right" && "text-right",
                          col.align === "center" && "text-center",
                          col.headerClassName,
                          headerClassName,
                        )}
                        onClick={() => handleSortClick(col)}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.header}
                          {col.sortable &&
                            (isSorted ? (
                              activeSort!.direction === "asc" ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-30" />
                            ))}
                        </span>
                        {enableColumnResizing && (
                          <span
                            className="group absolute right-0 top-0 z-30 flex h-full w-3 cursor-col-resize select-none items-center justify-center touch-none"
                            onMouseDown={(e) => startResize(e, col)}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="h-1/2 w-[3px] rounded-full bg-transparent transition-colors group-hover:bg-white/60" />
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {pageRows.map(({ row, id }, rowIndex) => {
                  const globalRowIndex = paginationMode === "client" ? safePageIndex * pSize + rowIndex : rowIndex;
                  const clickable = onRowClick ? (isRowClickable ? isRowClickable(row) : true) : false;
                  const expandable = renderExpandedRow
                    ? isRowExpandable
                      ? isRowExpandable(row)
                      : true
                    : false;
                  const isExpanded = expandable && expandedRowId === id;
                  const selectable = isRowSelectable ? isRowSelectable(row) : true;

                  return (
                    <Fragment key={id}>
                      <tr
                        className={cn(
                          "transition-colors hover:bg-[#001d6e]/[0.04]",
                          clickable && "cursor-pointer",
                          enableZebraStripes && (rowIndex % 2 === 1 ? "bg-slate-50" : "bg-white"),
                          rowClassName?.(row, globalRowIndex),
                          selectedSet.has(id) && "bg-muted/50",
                        )}
                        onClick={() => clickable && onRowClick?.(row)}
                      >
                        {enableRowSelection && (
                          <td
                            className="border-b border-r border-gray-200 px-2 py-1.5 align-middle sm:px-2.5 sm:py-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-center">
                              {selectable && (
                                <Checkbox
                                  checked={selectedSet.has(id)}
                                  onCheckedChange={() => toggleRowSelected(id)}
                                  aria-label="Select row"
                                />
                              )}
                            </div>
                          </td>
                        )}
                        {visibleColumns.map((col) => {
                          const isPinned = isStickyHeader && stickyColumnId === col.id;
                          const value = col.render ? col.render(row, globalRowIndex) : cellText(getCellValue(row, col));
                          return (
                            <td
                              key={col.id}
                              className={cn(
                                "border-b border-r border-gray-200 px-2 py-1.5 align-middle text-[11px] sm:px-2.5 sm:py-2 sm:text-xs",
                                isPinned &&
                                  "sticky left-0 z-[5] bg-background shadow-[2px_0_4px_-1px_rgba(0,0,0,0.08)]",
                                col.align === "right" && "text-right",
                                col.align === "center" && "text-center",
                                col.cellClassName,
                              )}
                              onClick={col.preventRowClick ? (e) => e.stopPropagation() : undefined}
                            >
                              {value}
                            </td>
                          );
                        })}
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={totalColSpan} className="p-0">
                            {renderExpandedRow!(row)}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              {enableTotalsRow && allRows.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-[#001d6e]/20 bg-[#001d6e]/[0.04] font-bold text-gray-900">
                    {enableRowSelection && <td className="border-b border-r border-gray-200 px-2 py-2" />}
                    {visibleColumns.map((col, colIndex) => {
                      // The label goes in the first cell; every other cell shows its column total.
                      const isFirst = colIndex === 0 && !enableRowSelection;
                      return (
                        <td
                          key={col.id}
                          className={cn(
                            "border-b border-r border-gray-200 px-2 py-2 align-middle text-xs sm:px-2.5",
                            col.align === "right" && "text-right",
                            col.align === "center" && "text-center",
                          )}
                        >
                          {isFirst ? totalsLabel : columnTotal(col, totalsRows)}
                        </td>
                      );
                    })}
                  </tr>
                </tfoot>
              )}
              {renderFooter && renderFooter(footerCtx)}
            </table>
          </div>
          {!renderFooter && paginationMode === "client" && (
            <DataTablePagination
              pageIndex={safePageIndex}
              pageCount={pageCount}
              pageSize={pSize}
              pageSizeOptions={pageSizeOptions}
              totalRows={allRows.length}
              onPageIndexChange={setPageIndex}
              onPageSizeChange={setPageSize}
            />
          )}
        </div>
      )}
    </div>
  );
}
