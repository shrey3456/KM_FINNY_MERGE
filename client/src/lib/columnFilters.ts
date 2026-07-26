// Generic, Excel-style "pick a column, pick some values or a condition" filter engine — one
// filter per column, triggered from a small icon on that column's header (or a global "+
// Filter" button that lets you pick the column first). Every column defaults to a searchable
// checklist of its own distinct values ("Values" — like Excel's AutoFilter dropdown); a
// "Condition" tab covers what a checklist can't (contains, >, between, before/after…).
// Hand-rolled instead of a query-builder library: the operator set is small and fixed, and
// nothing here needs arbitrary AND/OR nesting a library would actually help with.
import { format } from "date-fns";

export type FilterType = "text" | "number" | "date" | "enum";

export type FilterOption = { value: string; label: string };

export type FilterOperator = {
  id: string;
  label: string;
  // How many value inputs the "Condition" tab should render: 0 (e.g. "Is empty"), 1 (a single
  // box), or 2 ("Between" — from/to). "Is one of" (arity "multi") lives on the Values tab, not
  // here, so it's intentionally not part of this per-type list.
  arity: 0 | 1 | 2;
};

export const OPERATORS: Record<FilterType, FilterOperator[]> = {
  text: [
    { id: "contains", label: "Contains", arity: 1 },
    { id: "equals", label: "Equals", arity: 1 },
    { id: "empty", label: "Is empty", arity: 0 },
  ],
  number: [
    { id: "eq", label: "=", arity: 1 },
    { id: "gt", label: ">", arity: 1 },
    { id: "lt", label: "<", arity: 1 },
    { id: "between", label: "Between", arity: 2 },
  ],
  date: [
    { id: "on", label: "On", arity: 1 },
    { id: "before", label: "Before", arity: 1 },
    { id: "after", label: "After", arity: 1 },
    { id: "between", label: "Between", arity: 2 },
  ],
  enum: [
    { id: "equals", label: "Equals", arity: 1 },
  ],
};

export function defaultOperator(type: FilterType): string {
  return OPERATORS[type][0].id;
}

export function operatorOf(type: FilterType, operatorId: string): FilterOperator | undefined {
  return OPERATORS[type].find((o) => o.id === operatorId);
}

// A column the filter system can offer. `accessor` + `options` are only used for matching and
// for populating the Values checklist (client-side); pass distinct values already present in
// the loaded rows, pre-formatted (e.g. dates bucketed to a day, numbers rounded for display).
export type FilterableColumn<T = any> = {
  id: string;
  label: string;
  filterType: FilterType;
  options: FilterOption[];
  accessor: (row: T) => string | number | null | undefined;
  /** Skip the Values checklist entirely — just the Condition form, no tab switcher. For
   *  high-cardinality numeric columns (e.g. Qty) where "every value that ever occurred" isn't a
   *  useful checklist; typing a number/range is the only sensible way to filter it. */
  disableValues?: boolean;
};

export type FilterValue = string | [string, string] | string[];

export type FilterCondition = {
  columnIds: string[]; // always length 1 from the current UI; kept as an array for the matcher
  operator: string; // one of OPERATORS[type], or "in" for a Values-tab checklist
  value: FilterValue;
};

export function isConditionEmpty(condition: FilterCondition): boolean {
  if (condition.columnIds.length === 0) return true;
  if (condition.operator === "in") return !((condition.value as string[])?.length > 0);
  if (condition.operator === "empty") return false; // needs no value to be active
  if (condition.operator === "between") {
    const [a, b] = (condition.value as [string, string]) ?? ["", ""];
    return !a && !b;
  }
  return !condition.value || (condition.value as string) === "";
}

function dayBucket(cell: unknown): string | null {
  if (!cell) return null;
  const d = new Date(cell as string);
  return Number.isNaN(d.getTime()) ? null : format(d, "yyyy-MM-dd");
}

function matchValue(cell: unknown, type: FilterType, operator: string, value: FilterValue): boolean {
  if (operator === "in") {
    const selected = value as string[];
    const raw = type === "date" ? dayBucket(cell) : (cell == null ? null : String(cell));
    return raw != null && selected.includes(raw);
  }
  if (type === "text") {
    const c = String(cell ?? "").toLowerCase();
    if (operator === "empty") return c === "";
    const v = String(value).toLowerCase();
    return operator === "contains" ? c.includes(v) : c === v;
  }
  if (type === "number") {
    const c = Number(cell);
    if (cell == null || Number.isNaN(c)) return false;
    if (operator === "between") {
      const [a, b] = value as [string, string];
      return c >= Number(a) && c <= Number(b);
    }
    const v = Number(value);
    return operator === "eq" ? c === v : operator === "gt" ? c > v : c < v;
  }
  if (type === "date") {
    const c = cell ? new Date(cell as string).getTime() : NaN;
    if (Number.isNaN(c)) return false;
    if (operator === "between") {
      const [a, b] = value as [string, string];
      return c >= new Date(a).getTime() && c <= new Date(b).getTime();
    }
    const v = new Date(value as string).getTime();
    if (Number.isNaN(v)) return false;
    if (operator === "on") return dayBucket(cell) === dayBucket(value as string);
    return operator === "before" ? c < v : c > v;
  }
  // enum
  return String(cell ?? "") === value;
}

export function matchCondition<T>(row: T, condition: FilterCondition, columns: FilterableColumn<T>[]): boolean {
  return condition.columnIds.some((id) => {
    const col = columns.find((c) => c.id === id);
    if (!col) return true; // unknown column id — fail open rather than hide rows unexpectedly
    return matchValue(col.accessor(row), col.filterType, condition.operator, condition.value);
  });
}

export function matchAllConditions<T>(row: T, conditions: FilterCondition[], columns: FilterableColumn<T>[]): boolean {
  return conditions.every((c) => isConditionEmpty(c) || matchCondition(row, c, columns));
}

// Human-readable chip label, e.g. `Category is one of: Pipes, Fittings` / `Stock between 10 and 50`.
export function conditionSummary<T>(condition: FilterCondition, columns: FilterableColumn<T>[]): string {
  const column = columns.find((c) => c.id === condition.columnIds[0]);
  const label = column?.label ?? condition.columnIds.join(", ");
  if (condition.operator === "in") {
    const selected = condition.value as string[];
    const labels = selected.map((v) => column?.options.find((o) => o.value === v)?.label ?? v);
    return `${label} is one of: ${labels.length ? labels.join(", ") : "…"}`;
  }
  const op = column ? operatorOf(column.filterType, condition.operator) : undefined;
  if (!op) return label;
  if (op.arity === 0) return `${label} ${op.label.toLowerCase()}`;
  if (op.arity === 2) {
    const [a, b] = (condition.value as [string, string]) ?? ["", ""];
    return `${label} ${op.label.toLowerCase()} ${a || "…"} and ${b || "…"}`;
  }
  return `${label} ${op.label.toLowerCase()} "${condition.value || "…"}"`;
}
