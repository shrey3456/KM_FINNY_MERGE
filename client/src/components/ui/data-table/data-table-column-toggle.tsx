import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChevronDown, Columns2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DataTableColumn } from "./types";

interface DataTableColumnToggleProps<TData> {
  columns: DataTableColumn<TData>[];
  visibleColumnIds: Set<string>;
  onToggleColumn: (id: string) => void;
  onSetAll: (visible: boolean) => void;
  /** Extra classes merged onto the "Columns" trigger button. */
  buttonClassName?: string;
  /**
   * Current column order (ids). Only used to list the columns in the order they actually appear —
   * reordering itself is done by dragging a column's header on the table, not from here.
   */
  columnOrder?: string[];
  /** Supply to offer a "Reset order" link that clears any dragged-in order. */
  onColumnOrderChange?: (ids: string[]) => void;
}

export function DataTableColumnToggle<TData>({
  columns,
  visibleColumnIds,
  onToggleColumn,
  onSetAll,
  buttonClassName,
  columnOrder,
  onColumnOrderChange,
}: DataTableColumnToggleProps<TData>) {
  const toggleableColumns = columns.filter((c) => c.hideable !== false);

  // List them in the order they're actually shown, so this reads as the table does once columns
  // have been dragged around. Applied as a sort so a column absent from the order (newly added,
  // or a saved order predating it) keeps its declared position instead of dropping out.
  const orderIndex = new Map((columnOrder ?? []).map((id, i) => [id, i]));
  const ordered = columnOrder?.length
    ? toggleableColumns
        .map((c, declaredIndex) => ({ c, declaredIndex }))
        .sort((a, b) => {
          const ai = orderIndex.get(a.c.id) ?? Infinity;
          const bi = orderIndex.get(b.c.id) ?? Infinity;
          return ai === bi ? a.declaredIndex - b.declaredIndex : ai - bi;
        })
        .map(({ c }) => c)
    : toggleableColumns;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-8 text-xs", buttonClassName)}>
          <Columns2 className="mr-1.5 h-3.5 w-3.5" />
          Columns
          <ChevronDown className="ml-1 h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex gap-2">
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => onSetAll(true)}
            >
              Select all
            </button>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => onSetAll(false)}
            >
              Deselect all
            </button>
          </div>
          {onColumnOrderChange && columnOrder?.length ? (
            <button
              type="button"
              className="text-xs text-gray-400 hover:text-gray-700 hover:underline"
              onClick={() => onColumnOrderChange([])}
              title="Put the columns back in their original order"
            >
              Reset order
            </button>
          ) : null}
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {ordered.map((col) => (
            <label
              key={col.id}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-muted"
            >
              <Checkbox
                checked={visibleColumnIds.has(col.id)}
                onCheckedChange={() => onToggleColumn(col.id)}
              />
              <span className="truncate">{col.header}</span>
            </label>
          ))}
        </div>
        {onColumnOrderChange && (
          <p className="mt-2 border-t pt-2 text-[11px] text-gray-400">
            To move a column, drag its header on the table.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
