import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { TableSkeleton } from "@/components/ui/loading-skeletons";
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

// ── Remembered column widths ─────────────────────────────────────────────────────────────────
// A width the user drags is a lasting preference, so it lives in localStorage rather than in
// component state that a navigation throws away. Reads and writes are wrapped: storage can be
// unavailable (private windows, blocked site data) and must never take the table down with it.
const COLUMN_WIDTH_STORAGE_PREFIX = "dt-widths:";

function readStoredColumnWidths(key: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    // Only finite positive numbers — a hand-edited or half-written entry must not push a column
    // to NaN/0 width, which would collapse the table.
    const widths: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) widths[id] = value;
    }
    return widths;
  } catch {
    return {};
  }
}

function writeStoredColumnWidths(key: string, widths: Record<string, number>) {
  try {
    if (Object.keys(widths).length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(widths));
  } catch {
    /* storage unavailable — widths simply won't be remembered */
  }
}

/**
 * The one totals-row look, exported so hand-built tables elsewhere (the Scan page's rotated-kiosk
 * and mobile tables, its card lists) match the tables driven by this component instead of drifting
 * into their own styling. A faint navy wash with a heavier rule on top, bold dark figures.
 *
 * The background must stay opaque: in a scrolling table the row pins itself to the bottom edge and
 * data rows slide underneath it.
 */
export const DATA_TABLE_TOTALS_ROW = "border-t-2 border-t-[#001d6e]/20 bg-[#f5f6f9] font-bold text-gray-900";

// Pins the totals row to the bottom of the scroll box. The top rule is repeated as an inset
// shadow because a border-collapse table drops a sticky cell's own border while it's stuck.
const TOTALS_STICKY = "sticky bottom-0 z-[9] shadow-[inset_0_2px_0_0_rgba(0,29,110,0.2)]";

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
  /**
   * Column ids in the order they should appear. Partial lists are fine — anything not named keeps
   * its declared position, so adding a column to the page doesn't require touching a saved order.
   * Pair with DataTableColumnToggle's own reorder controls, which produce this array.
   */
  columnOrder?: string[];
  /**
   * Supply this to let a column be dragged by its header onto another to move it there. Receives
   * the full id list of every column, hidden ones included.
   */
  onColumnOrderChange?: (ids: string[]) => void;
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
  /**
   * Where this table's dragged column widths are remembered. Defaults to the page's path plus this
   * table's own column ids, which is unique enough for every table in the app — pass one only to
   * tell two identical tables on the same page apart, or to share widths deliberately.
   */
  columnWidthStorageKey?: string;
  isStickyHeader?: boolean;
  // One or more leading columns (in column order) pinned to the left edge while scrolling the
  // table sideways — e.g. Barcode + Item Name staying put while the figures scroll underneath.
  // Independent of isStickyHeader (that's the vertical/top pin; this is horizontal/left), so it
  // works on a plain client-paginated table with no scroll box of its own too. Each one's left
  // offset is computed from the actual rendered width of whichever pinned columns come before it,
  // so resizing a pinned column keeps the next one lined up correctly.
  stickyColumnIds?: string[];
  maxHeight?: string;
  headerClassName?: string;
  showMobileSwipeHint?: boolean;
  enableZebraStripes?: boolean;
  /**
   * Close the table with a totals row. In a scrolling table (`isStickyHeader`) it pins itself to
   * the bottom edge of the scroll box — fixed there the way the header is fixed at the top — so
   * the numbers stay on screen without scrolling to the end. Totals cover every filtered row, not
   * just the current page, so they don't change as you page through. Columns auto-sum when their
   * accessor yields numbers; override per column with `total`, or opt out with `totalable: false`
   * (needed for numeric-looking identifiers such as barcodes, which must never be summed).
   */
  enableTotalsRow?: boolean;
  /** Label placed in the totals row. Defaults to the first visible column's cell. */
  totalsLabel?: string;
  /**
   * Column whose totals cell carries `totalsLabel`. Use it to keep the label out of a narrow
   * leading column (a "#" or status-icon column) where it would overflow. Falls back to the first
   * visible column when unset or when the named column is hidden.
   */
  totalsLabelColumnId?: string;
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
  columnOrder,
  onColumnOrderChange,
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
  columnWidthStorageKey,
  isStickyHeader = false,
  stickyColumnIds,
  maxHeight,
  headerClassName,
  showMobileSwipeHint,
  enableZebraStripes = false,
  enableTotalsRow = false,
  totalsLabel = "Total",
  totalsLabelColumnId,
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
  // Dragged widths survive leaving the page and coming back. They used to live in state alone, so
  // every navigation threw them away and the table snapped back to its defaults. The key is the
  // page path + this table's column ids: no call site has to pass anything, and a table whose
  // columns change (a column added later) starts fresh rather than restoring widths onto columns
  // that no longer line up.
  const [pathname] = useLocation();
  const widthsKey = columnWidthStorageKey ?? `${COLUMN_WIDTH_STORAGE_PREFIX}${pathname}:${columns.map((c) => c.id).join("|")}`;
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => readStoredColumnWidths(widthsKey));
  // The same component instance now showing a different table (or the same table on another page)
  // — load that one's saved widths instead of carrying the previous table's over.
  const loadedWidthsKeyRef = useRef(widthsKey);
  useEffect(() => {
    if (loadedWidthsKeyRef.current === widthsKey) return;
    loadedWidthsKeyRef.current = widthsKey;
    setColWidths(readStoredColumnWidths(widthsKey));
  }, [widthsKey]);
  // Set while a resize drag is in flight — see startResize and the header's onDragStart.
  const resizingRef = useRef(false);

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

  // Caller-chosen column order, when one is supplied. Applied as a SORT over the declared columns
  // rather than by rebuilding the list from the id array, so a column missing from the order (a
  // newly added one, or a stale saved order from before it existed) still renders — it just falls
  // back to its declared position instead of vanishing.
  const orderIndex = new Map((columnOrder ?? []).map((id, i) => [id, i]));
  const orderedColumns = columnOrder?.length
    ? columns
        .map((c, declaredIndex) => ({ c, declaredIndex }))
        .sort((a, b) => {
          const ai = orderIndex.get(a.c.id) ?? Infinity;
          const bi = orderIndex.get(b.c.id) ?? Infinity;
          return ai === bi ? a.declaredIndex - b.declaredIndex : ai - bi;
        })
        .map(({ c }) => c)
    : columns;
  const visibleColumns = orderedColumns.filter((c) => visibleColumnIds.has(c.id));

  // A "pinned" column keeps an exact pixel width: one marked fixedWidth, or one the user has dragged
  // to a width. Everything else stretches to fill the table. Pinning dragged columns is what makes a
  // resize follow the mouse both ways — as plain shares of a table that always fills the screen, a
  // column widened past the screen couldn't be dragged back narrow: once the table fit again, every
  // column re-stretched and the edge stopped following the cursor.
  const isPinnedColumn = (c: DataTableColumn<TData>) => !!c.fixedWidth || colWidths[c.id] != null;
  const hasFixedColumns = visibleColumns.some(isPinnedColumn);
  // The scroll box's real width — needed only for that pixel layout (see pixelWidthOf below).
  const scrollBoxRef = useRef<HTMLDivElement>(null);
  const [scrollBoxWidth, setScrollBoxWidth] = useState(0);
  useEffect(() => {
    if (!hasFixedColumns) return;
    const el = scrollBoxRef.current;
    if (!el) return;
    const update = () => setScrollBoxWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasFixedColumns]);

  // ── Column reordering by dragging a header onto another ────────────────────
  const canReorderColumns = !!onColumnOrderChange;
  const [dragColId, setDragColId] = useState<string | null>(null);
  const [dragOverColId, setDragOverColId] = useState<string | null>(null);

  /** True when `from` currently sits after `to`, i.e. dropping would insert it BEFORE `to`. */
  const dropsBefore = (from: string | null, to: string) => {
    if (!from) return false;
    const ids = orderedColumns.map((c) => c.id);
    return ids.indexOf(from) > ids.indexOf(to);
  };

  /**
   * Move one column to another's position, emitting the full id list of EVERY column — hidden
   * ones included. Reordering only what's visible would let a hidden column silently jump when it
   * was shown again, since it has no recorded place of its own.
   */
  const moveColumn = (fromId: string, toId: string) => {
    if (!onColumnOrderChange || fromId === toId) return;
    const ids = orderedColumns.map((c) => c.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, fromId);
    onColumnOrderChange(next);
  };

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
  const showTotalsRow = enableTotalsRow && allRows.length > 0;

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
    // The header is also draggable (column reordering). Both start from a mousedown inside the
    // same <th>, so this flag tells the drag handler to stand down — grabbing the resize grip
    // should widen the column, never pick it up and move it.
    resizingRef.current = true;
    const startX = e.clientX;
    // Start from the width the column is actually drawn at. Before its first drag a column may be
    // stretched wider than its set width; starting from the set width made it jump narrower the moment
    // the drag began.
    const headerCell = (e.currentTarget as HTMLElement).closest("th");
    const drawnWidth = headerCell ? Math.round(headerCell.getBoundingClientRect().width) : 0;
    const startWidth = drawnWidth > 0 ? drawnWidth : getColWidth(col);
    const minWidth = col.minWidth ?? 60;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      setColWidths((prev) => ({ ...prev, [col.id]: Math.max(minWidth, startWidth + delta) }));
    };
    const onUp = () => {
      resizingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // Saved once the drag ends, not on every mousemove. The updater is only a way to read the
      // final widths without a stale closure — it returns exactly what it was given.
      setColWidths((current) => {
        writeStoredColumnWidths(widthsKey, current);
        return current;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const computedHasActiveFilters = hasActiveFilters ?? (enableSearch && search.trim() !== "");
  const computedShowSwipeHint = showMobileSwipeHint ?? (data.length > 0 && visibleColumns.length > 3);

  // Where "Total" is printed. A caller-named column wins, but only while it's actually visible —
  // hiding it would otherwise drop the label entirely.
  const totalsLabelId =
    totalsLabelColumnId && visibleColumns.some((c) => c.id === totalsLabelColumnId)
      ? totalsLabelColumnId
      : visibleColumns[0]?.id;

  /**
   * The totals row, closing out the data. Only sticky when the table owns a scroll box
   * (`isStickyHeader`); left un-pinned otherwise it would latch onto whatever page-level scroller
   * happens to be its nearest scrolling ancestor. Its background must stay opaque — rows slide
   * underneath it — and the divider is drawn as an inset shadow because a `border-collapse`
   * table drops a sticky cell's own border while it's stuck.
   */
  const renderTotalsRow = () => {
    const sticky = isStickyHeader;
    // DATA_TABLE_TOTALS_ROW is the one totals look in the app — the hand-built tables on the Scan
    // page reuse it, so keep any change here in step with them.
    const base = `whitespace-nowrap border-r border-b border-r-gray-300 border-b-gray-300 px-2 py-1.5 align-middle text-[11px] tabular-nums sm:px-2.5 sm:py-2 sm:text-xs ${DATA_TABLE_TOTALS_ROW}`;

    return (
      <tr>
        {enableRowSelection && <td className={cn(base, sticky && TOTALS_STICKY)} />}
        {visibleColumns.map((col) => {
          const isPinned = !!stickyColumnIds?.includes(col.id);
          return (
            <td
              key={col.id}
              className={cn(
                base,
                sticky && TOTALS_STICKY,
                isPinned && "sticky z-[19] bg-background",
                // Keeps the top divider alongside the pinned column's right-edge shadow when the
                // row is ALSO bottom-pinned — a second `shadow-*` class would otherwise replace
                // it outright — and just the right-edge shadow on its own otherwise.
                isPinned &&
                  (sticky
                    ? "shadow-[inset_0_2px_0_0_rgba(0,29,110,0.2),2px_0_4px_-1px_rgba(0,0,0,0.08)]"
                    : "shadow-[2px_0_4px_-1px_rgba(0,0,0,0.08)]"),
                col.align === "right" && "text-right",
                col.align === "center" && "text-center",
              )}
              style={isPinned ? { left: `${stickyLeftOffsets[col.id] ?? 0}px` } : undefined}
            >
              {col.id === totalsLabelId ? totalsLabel : columnTotal(col, totalsRows)}
            </td>
          );
        })}
      </tr>
    );
  };

  const totalColSpan = visibleColumns.length + (enableRowSelection ? 1 : 0);
  const totalTableWidth =
    (enableRowSelection ? 40 : 0) + visibleColumns.reduce((sum, col) => sum + getColWidth(col), 0);

  // Pixel layout for tables with fixedWidth columns: fixed columns (and the selection checkbox)
  // keep their width, and the others split whatever space is left in proportion to their own
  // widths — never below those widths, so a narrow screen still scrolls sideways instead of
  // squeezing. The 1px spare keeps rounding from adding a stray horizontal scrollbar.
  const usePixelLayout = hasFixedColumns && scrollBoxWidth > 0;
  const fixedColumnsWidth =
    (enableRowSelection ? 40 : 0) + visibleColumns.filter(isPinnedColumn).reduce((sum, col) => sum + getColWidth(col), 0);
  const flexibleBaseWidth = visibleColumns.filter((c) => !isPinnedColumn(c)).reduce((sum, col) => sum + getColWidth(col), 0);
  const flexibleSpace = Math.max(flexibleBaseWidth, scrollBoxWidth - fixedColumnsWidth - 1);
  // Every column pinned and together narrower than the screen: the last one takes up the leftover, so
  // the table (and its navy header) still reaches the right edge instead of stopping short.
  const lastVisibleColumnId = visibleColumns[visibleColumns.length - 1]?.id;
  const allPinnedSpare = flexibleBaseWidth <= 0 ? Math.max(0, scrollBoxWidth - fixedColumnsWidth - 1) : 0;
  const pixelWidthOf = (col: DataTableColumn<TData>) =>
    isPinnedColumn(col) || flexibleBaseWidth <= 0
      ? getColWidth(col) + (col.id === lastVisibleColumnId ? allPinnedSpare : 0)
      : (getColWidth(col) / flexibleBaseWidth) * flexibleSpace;

  // Left offset for each sticky column — the running sum of the sticky columns BEFORE it (an
  // unpinned column in between, e.g. Sr No ahead of a pinned Item Name, just scrolls out of view
  // underneath; it isn't part of the sum). Reliable only in pixel layout (the column also needs
  // `fixedWidth: true`) — in plain percentage layout a column's on-screen width isn't knowable
  // without a live measurement, so an offset computed here could drift from its real edge.
  const stickyLeftOffsets: Record<string, number> = {};
  if (stickyColumnIds && stickyColumnIds.length > 0) {
    let acc = enableRowSelection ? 40 : 0;
    for (const col of visibleColumns) {
      if (!stickyColumnIds.includes(col.id)) continue;
      stickyLeftOffsets[col.id] = acc;
      acc += pixelWidthOf(col);
    }
  }

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
        // Table-shaped placeholder with this table's own column count, so the page keeps its layout
        // while the rows load. loadingLabel is still announced to screen readers.
        <div aria-label={typeof loadingLabel === "string" ? loadingLabel : undefined}>
          <TableSkeleton columns={visibleColumns.length} rows={6} className={containerClassName} />
        </div>
      ) : (
        // The table always renders — even with no rows at all — so the column headers stay on
        // screen and you can see the shape of the data. The empty/no-results message goes in the
        // body instead of replacing the whole table.
        <div className={cn("rounded-md border", containerClassName)}>
          {computedShowSwipeHint && (
            <div className="flex items-center justify-center gap-1.5 border-b bg-muted/40 py-1 sm:hidden">
              <span className="text-[10px] font-medium text-muted-foreground">
                ← Swipe left / right to see all columns →
              </span>
            </div>
          )}
          <div
            ref={scrollBoxRef}
            className="w-full overflow-x-auto"
            style={{
              overflowY: isStickyHeader ? "auto" : undefined,
              maxHeight: isStickyHeader ? maxHeight : undefined,
              WebkitOverflowScrolling: "touch",
            }}
          >
            <table
              className="border-collapse"
              style={
                usePixelLayout
                  ? { width: fixedColumnsWidth + (flexibleBaseWidth > 0 ? flexibleSpace : allPinnedSpare), tableLayout: "fixed" }
                  : { width: "100%", minWidth: totalTableWidth, tableLayout: "fixed" }
              }
            >
              <colgroup>
                {enableRowSelection && (
                  <col style={{ width: usePixelLayout ? "40px" : `${(40 / totalTableWidth) * 100}%` }} />
                )}
                {visibleColumns.map((col) => (
                  <col
                    key={col.id}
                    style={{
                      width: usePixelLayout ? `${pixelWidthOf(col)}px` : `${(getColWidth(col) / totalTableWidth) * 100}%`,
                    }}
                  />
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
                    const isPinned = !!stickyColumnIds?.includes(col.id);
                    const isSorted = activeSort?.columnId === col.id;
                    return (
                      <th
                        key={col.id}
                        // Drag a header onto another to move the column there. Only enabled when
                        // the caller supplies onColumnOrderChange; resizing takes precedence, so
                        // a drag that began on the resize grip is refused in onDragStart below.
                        draggable={canReorderColumns}
                        onDragStart={(e) => {
                          if (resizingRef.current) { e.preventDefault(); return; }
                          setDragColId(col.id);
                          e.dataTransfer.effectAllowed = "move";
                          // Firefox won't start a drag without data on the transfer.
                          e.dataTransfer.setData("text/plain", col.id);
                        }}
                        onDragOver={(e) => {
                          if (!canReorderColumns || !dragColId || dragColId === col.id) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (dragOverColId !== col.id) setDragOverColId(col.id);
                        }}
                        onDragLeave={() => { if (dragOverColId === col.id) setDragOverColId(null); }}
                        onDrop={(e) => {
                          if (!canReorderColumns || !dragColId) return;
                          e.preventDefault();
                          moveColumn(dragColId, col.id);
                          setDragColId(null);
                          setDragOverColId(null);
                        }}
                        onDragEnd={() => { setDragColId(null); setDragOverColId(null); }}
                        className={cn(
                          // overflow-hidden matters here: this table is table-layout:fixed, which
                          // fixes each column's BOX width but does nothing to content wider than
                          // it — without this, a header longer than its column doesn't wrap or
                          // truncate, it just bleeds visibly into the next column's own header
                          // text, rendering as overlapping, garbled-looking characters.
                          "relative overflow-hidden whitespace-nowrap border-b border-r bg-background px-2 py-2 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:px-2.5 sm:py-2.5 sm:text-[11px]",
                          isStickyHeader && "sticky top-0 z-10 bg-background",
                          // Independent of isStickyHeader — a left-pin works with no vertical
                          // sticky header at all, so it needs its own "sticky" + background here
                          // rather than only riding on the class above.
                          isPinned && "sticky z-20 bg-background shadow-[2px_0_4px_-1px_rgba(0,0,0,0.08)]",
                          col.sortable && "cursor-pointer select-none",
                          canReorderColumns && "cursor-grab active:cursor-grabbing",
                          // The column being carried fades; the one under the cursor shows a bar
                          // on the edge it would land against, so the drop position is never a
                          // guess. inset shadows, since a border would shift the column's width.
                          dragColId === col.id && "opacity-40",
                          dragOverColId === col.id &&
                            (dropsBefore(dragColId, col.id)
                              ? "shadow-[inset_3px_0_0_0_#facc15]"
                              : "shadow-[inset_-3px_0_0_0_#facc15]"),
                          col.align === "right" && "text-right",
                          col.align === "center" && "text-center",
                          col.headerClassName,
                          headerClassName,
                        )}
                        style={isPinned ? { left: `${stickyLeftOffsets[col.id] ?? 0}px` } : undefined}
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
                {pageRows.length === 0 && (
                  <tr>
                    <td colSpan={totalColSpan} className="border-b border-gray-200 px-3">
                      {/* Same renderer as the standalone empty state, so a rich
                          DataTableEmptyState (icon/title/description) works here too. A filter
                          that matched nothing reads differently from having no data at all. */}
                      {computedHasActiveFilters
                        ? renderEmptyState(noResultsState ?? emptyState, "No results match your filters.")
                        : renderEmptyState(emptyState, "No data found.")}
                    </td>
                  </tr>
                )}
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
                          const isPinned = !!stickyColumnIds?.includes(col.id);
                          const value = col.render ? col.render(row, globalRowIndex) : cellText(getCellValue(row, col));
                          return (
                            <td
                              key={col.id}
                              className={cn(
                                // Same overflow-hidden fix as the header <th> above, and for the
                                // same reason — a cell's own content (a button's label, a long
                                // value) wider than its fixed column otherwise bleeds into the
                                // next cell instead of being clipped. Safe for popovers/dropdowns
                                // rendered inside a cell — those portal their open content to
                                // <body>, so they're never actually descendants of this <td>.
                                "overflow-hidden border-b border-r border-gray-200 px-2 py-1.5 align-middle text-[11px] sm:px-2.5 sm:py-2 sm:text-xs",
                                isPinned &&
                                  "sticky z-[5] bg-background shadow-[2px_0_4px_-1px_rgba(0,0,0,0.08)]",
                                col.align === "right" && "text-right",
                                col.align === "center" && "text-center",
                                col.cellClassName,
                              )}
                              style={isPinned ? { left: `${stickyLeftOffsets[col.id] ?? 0}px` } : undefined}
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
                {/* Totals close out the data. Lives in <tbody> rather than a <tfoot> so it can't
                    collide with a consumer's own renderFooter. */}
                {showTotalsRow && renderTotalsRow()}
              </tbody>
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
