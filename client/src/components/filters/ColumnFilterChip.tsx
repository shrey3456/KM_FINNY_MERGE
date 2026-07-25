import { useState } from "react";
import { Filter, Pencil, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  type FilterableColumn, type FilterCondition, type FilterValue,
  OPERATORS, defaultOperator, isConditionEmpty, conditionSummary,
} from "@/lib/columnFilters";

// The value inputs for the "Condition" tab. Only ever gets arity 0/1/2 — the checklist ("is one
// of") lives on the Values tab and isn't routed through here.
function ValueEditor({
  column, arity, value, onChange,
}: {
  column: FilterableColumn;
  arity: 0 | 1 | 2;
  value: FilterValue;
  onChange: (v: FilterValue) => void;
}) {
  if (arity === 0) return null;

  const inputType = column.filterType === "number" ? "number" : column.filterType === "date" ? "date" : "text";

  if (arity === 2) {
    const [a, b] = (value as [string, string]) ?? ["", ""];
    return (
      <div className="flex items-center gap-1.5">
        <Input type={inputType} className="h-8 text-xs" value={a} onChange={(e) => onChange([e.target.value, b])} />
        <span className="text-xs text-gray-400">and</span>
        <Input type={inputType} className="h-8 text-xs" value={b} onChange={(e) => onChange([a, e.target.value])} />
      </div>
    );
  }

  if (column.filterType === "enum") {
    return (
      <Select value={(value as string) || undefined} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select…" /></SelectTrigger>
        <SelectContent>
          {column.options.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Input
      type={inputType}
      className="h-8 text-xs"
      placeholder="Value…"
      value={value as string}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// The Excel-style popover body: "Values" (searchable checklist of this column's actual distinct
// values — the default, fastest path) vs "Condition" (contains/>/between/etc., for when a
// checklist isn't the right tool). Shared by the header icon, the global "+ Filter" button, and
// the active-filter chip's edit popover — the column is always already fixed by the caller.
export function ColumnFilterPopoverContent({
  column, initial, initialTab, onApply, onClear, onCancel,
}: {
  column: FilterableColumn;
  initial?: FilterCondition;
  /** Which tab opens first when there's no existing condition to infer it from. Defaults to
   *  "values" — pass "condition" for columns whose Values checklist can't be fully populated
   *  (e.g. a server-paginated table, where only the current page's distinct values are known). */
  initialTab?: "values" | "condition";
  onApply: (condition: FilterCondition) => void;
  onClear?: () => void;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<"values" | "condition">(
    initial ? (initial.operator === "in" ? "values" : "condition") : (initialTab ?? "values"),
  );
  const [selectedValues, setSelectedValues] = useState<string[]>(
    initial?.operator === "in" ? (initial.value as string[]) : [],
  );
  const [search, setSearch] = useState("");
  const conditionOperators = OPERATORS[column.filterType];
  const [operator, setOperator] = useState(
    initial && initial.operator !== "in" ? initial.operator : defaultOperator(column.filterType),
  );
  const [condValue, setCondValue] = useState<FilterValue>(
    initial && initial.operator !== "in" ? initial.value : "",
  );

  const filteredOptions = column.options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()));

  const changeOperator = (id: string) => {
    setOperator(id);
    const arity = conditionOperators.find((o) => o.id === id)?.arity ?? 1;
    setCondValue(arity === 2 ? ["", ""] : "");
  };

  const activeCondition: FilterCondition =
    tab === "values"
      ? { columnIds: [column.id], operator: "in", value: selectedValues }
      : { columnIds: [column.id], operator, value: condValue };
  const canApply = !isConditionEmpty(activeCondition);

  return (
    <div className="space-y-3">
      <div className="flex divide-x divide-gray-300 rounded-md border border-gray-300 text-xs">
        <button
          type="button"
          onClick={() => setTab("values")}
          className={`flex-1 rounded-l-md px-2 py-1 font-medium ${tab === "values" ? "bg-[#001d6e] text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
        >
          Values
        </button>
        <button
          type="button"
          onClick={() => setTab("condition")}
          className={`flex-1 rounded-r-md px-2 py-1 font-medium ${tab === "condition" ? "bg-[#001d6e] text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
        >
          Condition
        </button>
      </div>

      {tab === "values" ? (
        <div className="space-y-1.5">
          <Input
            className="h-8 text-xs"
            placeholder="Search values…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex items-center justify-between text-[11px]">
            <button
              type="button"
              className="text-[#001d6e] hover:underline"
              onClick={() => setSelectedValues(filteredOptions.map((o) => o.value))}
            >
              Select all
            </button>
            <button type="button" className="text-gray-400 hover:underline" onClick={() => setSelectedValues([])}>
              Clear
            </button>
          </div>
          <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
            {filteredOptions.length === 0 ? (
              <div className="px-1 py-1 text-xs text-gray-400">No values</div>
            ) : (
              filteredOptions.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 px-1 py-0.5 text-xs text-gray-700">
                  <Checkbox
                    checked={selectedValues.includes(opt.value)}
                    onCheckedChange={(checked) =>
                      setSelectedValues((prev) => (checked ? [...prev, opt.value] : prev.filter((v) => v !== opt.value)))
                    }
                  />
                  <span className="truncate">{opt.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Select value={operator} onValueChange={changeOperator}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {conditionOperators.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <ValueEditor
            column={column}
            arity={conditionOperators.find((o) => o.id === operator)?.arity ?? 1}
            value={condValue}
            onChange={setCondValue}
          />
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        {initial && onClear ? (
          <Button size="sm" variant="ghost" className="h-7 px-1.5 text-xs text-red-500 hover:text-red-600" onClick={onClear}>
            Clear filter
          </Button>
        ) : <span />}
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
          <Button
            size="sm"
            className="h-7 bg-[#001d6e] text-xs text-white hover:bg-[#001552]"
            disabled={!canApply}
            onClick={() => onApply(activeCondition)}
          >
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

// The Excel-style filter icon that sits on a column header. Filled/highlighted when that column
// has an active filter. Stops propagation everywhere so it never also triggers the header's
// click-to-sort — Radix's Popover portals out of the <th> in the DOM, but clicks still bubble up
// the React tree, so both the trigger and the popped-out content need the stop.
export function ColumnHeaderFilterButton({
  column, condition, onChange, onRemove, initialTab,
}: {
  column: FilterableColumn;
  condition?: FilterCondition;
  onChange: (condition: FilterCondition) => void;
  onRemove: () => void;
  initialTab?: "values" | "condition";
}) {
  const [open, setOpen] = useState(false);
  const active = !!condition;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={`flex h-4 w-4 shrink-0 items-center justify-center normal-case ${active ? "text-amber-300" : "text-white/50 hover:text-white"}`}
          aria-label={`Filter ${column.label}`}
          title={`Filter ${column.label}`}
        >
          <Filter className="h-3 w-3" fill={active ? "currentColor" : "none"} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64" onClick={(e) => e.stopPropagation()}>
        {open && (
          <ColumnFilterPopoverContent
            column={column}
            initial={condition}
            initialTab={initialTab}
            onApply={(c) => { onChange(c); setOpen(false); }}
            onClear={() => { onRemove(); setOpen(false); }}
            onCancel={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

// Global fallback entry point — pick a column first (useful when its header isn't visible, e.g.
// scrolled out of view or on a small screen), then the same Values/Condition builder.
export function AddColumnFilterButton({
  columns, conditions, onApply, onClear, className,
}: {
  columns: FilterableColumn[];
  conditions: Record<string, FilterCondition>;
  onApply: (columnId: string, condition: FilterCondition) => void;
  onClear: (columnId: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pickedId, setPickedId] = useState("");
  const column = columns.find((c) => c.id === pickedId) ?? null;

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setPickedId(""); }}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={className ?? "h-8 gap-1 rounded-md border-dashed border-[#001d6e]/40 bg-white text-xs font-medium text-[#001d6e] hover:bg-[#001d6e]/5 hover:text-[#001d6e]"}
        >
          <Plus className="h-3.5 w-3.5" /> Filter
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Column</label>
            <Select value={pickedId || undefined} onValueChange={setPickedId}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Choose a column…" /></SelectTrigger>
              <SelectContent>
                {columns.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {column && (
            <ColumnFilterPopoverContent
              key={column.id}
              column={column}
              initial={conditions[column.id]}
              onApply={(c) => { onApply(column.id, c); setOpen(false); setPickedId(""); }}
              onClear={() => { onClear(column.id); setOpen(false); setPickedId(""); }}
              onCancel={() => setOpen(false)}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// An active filter, shown as a removable/editable chip — a quick-glance summary of everything
// currently filtered, independent of whether that column's header is currently visible.
export function ColumnFilterChipView({
  columnId, condition, columns, onEdit, onRemove,
}: {
  columnId: string;
  condition: FilterCondition;
  columns: FilterableColumn[];
  onEdit: (condition: FilterCondition) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const column = columns.find((c) => c.id === columnId);
  if (!column) return null;
  return (
    <div className="flex h-8 items-center gap-1 rounded-md border border-[#001d6e]/30 bg-[#001d6e]/[0.04] pl-2 pr-1 text-xs">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="flex items-center gap-1 font-medium text-[#001d6e] hover:underline">
            <Pencil className="h-3 w-3 opacity-60" />
            {conditionSummary(condition, columns)}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64">
          {open && (
            <ColumnFilterPopoverContent
              column={column}
              initial={condition}
              onApply={(c) => { onEdit(c); setOpen(false); }}
              onClear={() => { onRemove(); setOpen(false); }}
              onCancel={() => setOpen(false)}
            />
          )}
        </PopoverContent>
      </Popover>
      <button
        type="button"
        onClick={onRemove}
        className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-[#001d6e]/10 hover:text-[#001d6e]"
        aria-label="Remove filter"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
