import type { ReactNode, ComponentType } from "react";

export interface DataTableColumn<TData> {
  id: string;
  header: ReactNode;
  accessor?: (row: TData) => unknown;
  /** rowIndex is the row's 0-based position in the full sorted/filtered dataset (not just the current page). */
  render?: (row: TData, rowIndex: number) => ReactNode;
  sortable?: boolean;
  width?: number;
  minWidth?: number;
  isSticky?: boolean;
  isHiddenByDefault?: boolean;
  /** Set false to exclude this column from the column-visibility toggle (always shown). */
  hideable?: boolean;
  align?: "left" | "center" | "right";
  headerClassName?: string;
  cellClassName?: string;
  /** Stops the row's onClick (e.g. expansion toggle) from firing when this cell is clicked. */
  preventRowClick?: boolean;
}

export interface DataTableEmptyState {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

export type DataTableSortDirection = "asc" | "desc";

export interface DataTableSortState {
  columnId: string;
  direction: DataTableSortDirection;
}

export interface DataTableFooterContext {
  pageIndex: number;
  pageCount: number;
  pageSize: number;
  totalRows: number;
  /** Number of currently rendered <td> columns (visible columns + selection column, if any) — use as colSpan. */
  columnCount: number;
  setPageIndex: (index: number) => void;
  setPageSize: (size: number) => void;
}
