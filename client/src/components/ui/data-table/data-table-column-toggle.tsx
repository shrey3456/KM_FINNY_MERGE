import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Columns3 } from "lucide-react";
import type { DataTableColumn } from "./types";

interface DataTableColumnToggleProps<TData> {
  columns: DataTableColumn<TData>[];
  visibleColumnIds: Set<string>;
  onToggleColumn: (id: string) => void;
  onSetAll: (visible: boolean) => void;
}

export function DataTableColumnToggle<TData>({
  columns,
  visibleColumnIds,
  onToggleColumn,
  onSetAll,
}: DataTableColumnToggleProps<TData>) {
  const toggleableColumns = columns.filter((c) => c.hideable !== false);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Columns3 className="mr-2 h-4 w-4" />
          Columns
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
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {toggleableColumns.map((col) => (
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
      </PopoverContent>
    </Popover>
  );
}
