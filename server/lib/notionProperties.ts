// Shared helpers for reading values out of a Notion page's `properties` object, regardless
// of which property type Notion assigned it (title, rich_text, select, number, formula,
// rollup, ...). Used by every Notion-synced table in this app (Product Master, Vehicle
// Master) so the same property-type quirks are handled once, not once per sync service.

export function extractText(prop: any): string {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':       return prop.title?.map((t: any) => t.plain_text).join('') || '';
    case 'rich_text':   return prop.rich_text?.map((t: any) => t.plain_text).join('') || '';
    case 'select':      return prop.select?.name || '';
    case 'status':      return prop.status?.name || '';
    case 'multi_select':return prop.multi_select?.map((s: any) => s.name).join(', ') || '';
    case 'number':      return prop.number != null ? String(prop.number) : '';
    case 'checkbox':    return prop.checkbox != null ? String(prop.checkbox) : '';
    case 'date':        return prop.date?.start ?? '';
    case 'email':       return prop.email ?? '';
    case 'phone_number':return prop.phone_number ?? '';
    case 'people':       return (prop.people ?? []).map((p: any) => p.name).filter(Boolean).join(', ') || '';
    case 'created_time': return prop.created_time ?? '';
    case 'last_edited_time': return prop.last_edited_time ?? '';
    case 'created_by':  return prop.created_by?.name ?? '';
    case 'last_edited_by': return prop.last_edited_by?.name ?? '';
    case 'files':        return extractFileUrl(prop);
    case 'formula':
      if (prop.formula?.type === 'string') return prop.formula.string || '';
      if (prop.formula?.type === 'number') return prop.formula.number != null ? String(prop.formula.number) : '';
      if (prop.formula?.type === 'date') return prop.formula.date?.start ?? '';
      if (prop.formula?.type === 'boolean') return prop.formula.boolean != null ? String(prop.formula.boolean) : '';
      return '';
    case 'rollup':
      if (prop.rollup?.type === 'number') return prop.rollup.number != null ? String(prop.rollup.number) : '';
      if (prop.rollup?.type === 'date') return prop.rollup.date?.start ?? '';
      if (prop.rollup?.type === 'array')
        return prop.rollup.array?.map((i: any) => extractText(i)).filter(Boolean).join(', ') || '';
      return '';
    case 'url': return prop.url ?? '';
    default: return '';
  }
}

export function extractInteger(prop: any): number | undefined {
  if (!prop) return undefined;
  if (prop.type === 'number' && prop.number != null && prop.number > 0) return Math.round(prop.number);
  const text = extractText(prop);
  if (!text) return undefined;
  const n = parseFloat(text.replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

// Like extractInteger, but keeps decimals (for measurements like volume/percentages)
// instead of rounding to a whole number, and allows 0/negative values through.
export function extractFloat(prop: any): number | undefined {
  if (!prop) return undefined;
  if (prop.type === 'number' && prop.number != null) return prop.number;
  const text = extractText(prop);
  if (!text) return undefined;
  const n = parseFloat(text.replace(/[₹,\s%]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export function extractBoolean(prop: any): boolean | undefined {
  if (!prop) return undefined;
  if (prop.type === 'checkbox') return !!prop.checkbox;
  const text = extractText(prop).trim().toLowerCase();
  if (!text) return undefined;
  if (['yes', 'true', 'y'].includes(text)) return true;
  if (['no', 'false', 'n'].includes(text)) return false;
  return undefined;
}

export function extractMultiSelect(prop: any): string[] {
  if (!prop) return [];
  if (prop.type === 'multi_select') return (prop.multi_select ?? []).map((s: any) => String(s.name)).filter(Boolean);
  if (prop.type === 'status')  return prop.status?.name  ? [String(prop.status.name)]  : [];
  if (prop.type === 'select')  return prop.select?.name  ? [String(prop.select.name)]  : [];
  return [];
}

export function multiSelectToText(values: string[]): string | null {
  return values.length > 0 ? values.join(', ') : null;
}

// Notion "Files & media" properties aren't covered by extractText (it only handles
// text-like property types) — the URL lives at a different path depending on whether
// the file was uploaded to Notion directly (type 'file', a presigned S3 URL that
// EXPIRES after ~1 hour) or linked externally (type 'external', a stable URL). Either
// way, the caller must use this URL immediately (download it), never persist it as-is
// long-term for Notion-hosted files.
export function extractFileUrl(prop: any): string {
  if (!prop || prop.type !== 'files') return '';
  const first = (prop.files ?? [])[0];
  if (!first) return '';
  if (first.type === 'external') return first.external?.url ?? '';
  if (first.type === 'file') return first.file?.url ?? '';
  return '';
}

// A Relation property only carries related page IDs, with no readable text of its own — to
// show something useful, the Notion database needs a paired Rollup property that surfaces
// the related page's title. This just reads that rollup (same shape extractText already
// handles); it exists as a distinctly-named helper so callers document intent — "this field
// is a relation's rollup, not a plain property" — at the call site.
export function extractRelationRollupText(prop: any): string {
  return extractText(prop);
}

export function firstOf(props: any, ...keys: string[]): string {
  for (const key of keys) {
    const val = extractText(props[key]);
    if (val.trim()) return val.trim();
  }
  return '';
}
