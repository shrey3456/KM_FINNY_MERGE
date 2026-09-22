// The generic "+ Filter" column engine (client/src/lib/columnFilters.ts) mirrored server-side.
// A paginated list can only filter correctly across the WHOLE result set in SQL — filtering the
// page already fetched leaves later pages unfiltered, which is what made Scan History show a Load
// row on page 103 under a Scan-only filter, and what made Unloading's own column filters apply to
// the current page alone.
//
// Only columns a caller has put in its own allowlist are ever touched: the column id and its SQL
// expression are fixed server-side, so a request can never name an arbitrary column.
// Semantics match the frontend's matchCondition exactly: AND across conditions, OR across the
// columns picked into one condition.
export type SqlFilterColumn = { sql: string; type: 'text' | 'number' | 'date' };

type GenericFilterCondition = { columnIds?: string[]; operator?: string; value?: unknown };

// Appends zero or more SQL clauses (one per condition, columns within a condition OR'd
// together) onto `conditions`/`params` — same shape/semantics as the frontend's matchCondition:
// AND across conditions, OR across the columns picked into one condition.
export function applyColumnFiltersToSql(
  filtersParam: string | undefined,
  columns: Record<string, SqlFilterColumn>,
  conditions: string[],
  params: any[],
) {
  if (!filtersParam) return;
  let parsed: unknown;
  try { parsed = JSON.parse(filtersParam); } catch { return; }
  if (!Array.isArray(parsed)) return;

  for (const raw of parsed as GenericFilterCondition[]) {
    const columnIds = Array.isArray(raw?.columnIds) ? raw.columnIds : [];
    const operator = typeof raw?.operator === 'string' ? raw.operator : '';
    if (columnIds.length === 0 || !operator) continue;

    const colClauses: string[] = [];
    for (const columnId of columnIds) {
      const col = columns[columnId];
      if (!col) continue; // not in the allowlist — ignore rather than error
      const clause = buildFilterClause(col, operator, raw.value, params);
      if (clause) colClauses.push(clause);
    }
    if (colClauses.length > 0) conditions.push(`(${colClauses.join(' OR ')})`);
  }
}

function buildFilterClause(
  col: SqlFilterColumn,
  operator: string,
  value: unknown,
  params: any[],
): string | null {
  const push = (v: any) => { params.push(v); return `$${params.length}`; };

  if (operator === 'in') {
    const values = Array.isArray(value) ? (value as string[]) : [];
    if (values.length === 0) return null;
    if (col.type === 'date') {
      return `(${values.map((v) => `DATE(${col.sql}) = ${push(v)}::date`).join(' OR ')})`;
    }
    if (col.type === 'number') {
      const nums = values.map(Number).filter((n) => !Number.isNaN(n));
      return nums.length ? `${col.sql} = ANY(${push(nums)}::numeric[])` : null;
    }
    return `LOWER(COALESCE(${col.sql}::text,'')) = ANY(${push(values.map((v) => v.toLowerCase()))}::text[])`;
  }

  if (col.type === 'text') {
    const v = typeof value === 'string' ? value : '';
    if (operator === 'empty') return `COALESCE(${col.sql}::text,'') = ''`;
    if (operator === 'contains') return `LOWER(COALESCE(${col.sql}::text,'')) LIKE ${push(`%${v.toLowerCase()}%`)}`;
    if (operator === 'equals') return `LOWER(COALESCE(${col.sql}::text,'')) = ${push(v.toLowerCase())}`;
    return null;
  }

  if (col.type === 'number') {
    if (operator === 'between') {
      const [a, b] = Array.isArray(value) ? (value as string[]) : ['', ''];
      if (a === '' && b === '') return null;
      return `${col.sql} BETWEEN ${push(Number(a) || 0)} AND ${push(Number(b) || 0)}`;
    }
    const n = Number(value);
    if (Number.isNaN(n)) return null;
    if (operator === 'eq') return `${col.sql} = ${push(n)}`;
    if (operator === 'gt') return `${col.sql} > ${push(n)}`;
    if (operator === 'lt') return `${col.sql} < ${push(n)}`;
    return null;
  }

  // date
  if (operator === 'between') {
    const [a, b] = Array.isArray(value) ? (value as string[]) : ['', ''];
    if (!a && !b) return null;
    return `DATE(${col.sql}) BETWEEN ${push(a || '1970-01-01')}::date AND ${push(b || '9999-12-31')}::date`;
  }
  const v = typeof value === 'string' ? value : '';
  if (!v) return null;
  if (operator === 'on') return `DATE(${col.sql}) = ${push(v)}::date`;
  if (operator === 'before') return `${col.sql} < ${push(v)}::date`;
  if (operator === 'after') return `${col.sql} >= ${push(v)}::date + INTERVAL '1 day'`;
  return null;
}
