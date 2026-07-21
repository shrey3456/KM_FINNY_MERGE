import { Router } from 'express';
import { Client } from '@notionhq/client';
import { requirePageAccess } from '../lib/pageAccess';

const router = Router();

// Simple in-memory cache to speed up repeated searches
const searchCache = new Map<string, { data: any, timestamp: number }>();
const partyCache = new Map<string, { data: any, timestamp: number }>();
const CACHE_DURATION = (60 * 1000)/2; // 1 hour cache for maximum speed

// Driver master-list cache for the search-bar autocomplete: refreshed at
// most once per DRIVER_LIST_CACHE_DURATION so typing in the search box never
// hits Notion per keystroke -- suggestions are filtered from this cache.
// Stale entries are still served instantly (see getDriverNameList) while a
// fresh copy is fetched in the background, so this duration only controls
// how often that background refresh happens, never how long a user waits.
let driverNameListCache: { names: string[]; timestamp: number } | null = null;
const DRIVER_LIST_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNotionError(error: any): boolean {
  const status = error?.status;
  const code = error?.code;
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === 'notionhq_client_request_timeout'
  );
}

async function queryNotionWithRetry(
  notion: Client,
  queryParams: Record<string, any>,
  maxAttempts = 3
): Promise<any> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await notion.databases.query(queryParams as any);
    } catch (error: any) {
      lastError = error;
      if (!isRetryableNotionError(error) || attempt === maxAttempts) {
        throw error;
      }

      const backoffMs = attempt * 1000;
      console.warn(
        `Notion query retry ${attempt}/${maxAttempts} after error status ${error?.status || 'unknown'}`
      );
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

function normalizeVoucherValue(value: string): string {
  return value.trim().toUpperCase();
}

// Today's date as YYYY-MM-DD in the server's local timezone.
function getTodayDateStr(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Accepts only a strict YYYY-MM-DD string from the client. The date is
// OPTIONAL: anything else (missing, empty, malformed) returns null, meaning
// "search across all dates" -- no date scope is applied.
function normalizeVoucherDate(input: any): string | null {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }
  return null;
}

// Notion filter fragment that scopes a query to vouchers whose "Voucher Date :"
// property equals the given day. Returns null when no date is given, so callers
// can omit the date scope entirely and search across all dates.
function buildDateFilter(voucherDate: string | null) {
  if (!voucherDate) return null;
  return { property: 'Voucher Date :', date: { equals: voucherDate } };
}

// Human-readable label for log/response messages when the date may be absent.
function dateScopeLabel(voucherDate: string | null): string {
  return voucherDate ?? 'all dates';
}

// The AEV expense-voucher database stores some fields under different property
// names than the regular EV database (which the print template / merge read).
// Map each canonical key (the print reads) to the AEV alias(es) that hold the
// same value, so both schemas produce identical output.
const FIELD_ALIASES: Record<string, string[]> = {
  "KM's SUM": ["KM's:", "Overall KM's :"],
  'Toll Tax :': ['Toll:'],
  'OnRoad Work :': ['On Road Arrangement:'],
  'For Diesel Bill No. :': ['⛽️ Bill No. :'],
};

// Build the { propertyName: displayValue } map for a Notion page's properties.
// Shared so a single voucher and each merge-candidate voucher are parsed identically.
function buildVoucherInfo(properties: Record<string, any>): Record<string, string> {
  const info: Record<string, string> = {};

  for (const [key, value] of Object.entries(properties)) {
    const prop = value as any;
    let displayValue = '';

    switch (prop.type) {
      case 'title':
      case 'rich_text':
        // Notion splits a single text value into multiple rich_text "runs"
        // whenever part of it is styled differently (colour, bold, a link).
        // Reading only run [0] truncates values like "228 {GJ-15-AX-7255}"
        // to "228 {", so concatenate every run's plain_text.
        displayValue = (prop[prop.type] as any[] | undefined)?.map((t) => t.plain_text).join('') || '';
        break;
      case 'date':
        if (prop.date?.start) {
          const date = new Date(prop.date.start);
          displayValue = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
        }
        break;
      case 'select':
        displayValue = prop.select?.name || '';
        break;
      case 'status':
        displayValue = prop.status?.name || '';
        break;
      case 'number':
        displayValue = prop.number?.toString() || '';
        break;
      case 'formula':
        if (prop.formula?.string) {
          displayValue = prop.formula.string;
        } else if (prop.formula?.number) {
          displayValue = prop.formula.number.toString();
        }
        break;
      case 'rollup':
        if (prop.rollup?.array && prop.rollup.array.length > 0) {
          const firstItem = prop.rollup.array[0];
          if (firstItem?.rich_text?.length) {
            displayValue = (firstItem.rich_text as any[]).map((t) => t.plain_text).join('');
          } else if (firstItem?.title?.length) {
            displayValue = (firstItem.title as any[]).map((t) => t.plain_text).join('');
          } else if (firstItem?.phone_number) {
            displayValue = firstItem.phone_number;
          }
        }
        break;
      case 'phone_number':
        displayValue = prop.phone_number || '';
        break;
    }

    if (displayValue) {
      info[key] = displayValue;
    }
  }

  // Fill canonical keys from AEV aliases when the canonical field is absent,
  // so the print/merge (which read the EV names) work for AEV vouchers too.
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (info[canonical] !== undefined && info[canonical] !== '') continue;
    for (const alias of aliases) {
      if (info[alias] !== undefined && info[alias] !== '') {
        info[canonical] = info[alias];
        break;
      }
    }
  }

  return info;
}

// Build the Order Details party text from one or more vouchers. Only vouchers
// whose Authorisation is "Approved" or "Adjusted" contribute. Each party line
// is prefixed with the voucher number it came from (voucher number BEFORE the
// party name, no brackets), deduped, and sorted by the embedded order date.
function buildPartyText(infos: Record<string, string>[]): string | undefined {
  const partyKey = 'For Party x Ord Date';
  const isAuthorizedForParty = (info: Record<string, string>) => {
    const status = (info['Authorisation :'] || '').trim().toLowerCase();
    return status === 'approved' || status === 'adjusted';
  };

  const seenParty = new Set<string>();
  const partyLines: string[] = [];
  for (const info of infos) {
    if (!isAuthorizedForParty(info)) continue;
    const text = info[partyKey];
    if (!text) continue;
    const vno = (info['Voucher No. :'] || '').trim();
    const voucherTag = vno.lastIndexOf('-') >= 0 ? vno.slice(vno.lastIndexOf('-') + 1) : vno;
    for (const line of String(text).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Voucher number first, then the party name (no brackets).
      const tagged = voucherTag ? `${voucherTag} ${trimmed}` : trimmed;
      if (!seenParty.has(tagged)) {
        seenParty.add(tagged);
        partyLines.push(tagged);
      }
    }
  }

  // Sort by the order date embedded in each line, e.g.
  // "GANGA ENTERPRISES - KADMA {01/07/26}" -> 01/07/26. Lines without a
  // parseable date are pushed to the end.
  const partyDateValue = (line: string): number => {
    const m = line.match(/\{?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*\}?/);
    if (!m) return Number.POSITIVE_INFINITY;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    return new Date(year, month - 1, day).getTime();
  };
  partyLines.sort((a, b) => partyDateValue(a) - partyDateValue(b));

  return partyLines.length > 0 ? partyLines.join('\n') : undefined;
}

// Merge several vouchers' info maps into one:
//  - Toll, OnRoad and Amount are summed across every voucher.
//  - Conveyance Allowance and Deduction are summed ONLY over Approved vouchers;
//    Final Payment (ECS) = Toll + OnRoad + approved Conveyance - approved Deduction.
//  - Diesel liters are summed once per UNIQUE diesel bill no. Average = KM / litres.
//  - Route KM's = sum of Approved vouchers' KM + any "EXTRA KM. <n>" found in remarks.
//  - Diesel bill nos and Voucher nos are listed (deduped). Party lines are merged.
// Identity fields (Vehicle, Driver, Date, Location...) come from the first voucher.
function mergeVoucherInfos(infos: Record<string, string>[]): Record<string, string> {
  if (infos.length === 0) return {};

  const parseNum = (v: any): number => {
    if (v === undefined || v === null) return 0;
    const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  const merged: Record<string, string> = { ...infos[0] };

  // Order Details party name (voucher number prefixed) is only shown when
  // Authorisation is "Approved"/"Adjusted" -- applies even to a single voucher.
  const singleParty = buildPartyText([infos[0]]);
  if (singleParty) {
    merged['For Party x Ord Date'] = singleParty;
  } else {
    delete merged['For Party x Ord Date'];
  }

  if (infos.length === 1) return merged;

  // Sum expense amounts across every voucher
  const SUM_FIELDS = [
    'Toll Tax :',
    'OnRoad Work :',
    'Amount >'
  ];
  for (const field of SUM_FIELDS) {
    let total = 0;
    let hasValue = false;
    for (const info of infos) {
      if (info[field] !== undefined) {
        total += parseNum(info[field]);
        hasValue = true;
      }
    }
    if (hasValue) merged[field] = String(total);
  }

  // Conveyance Allowance and Deduction are summed ONLY over vouchers whose
  // Authorisation status is "Approved". Final Payment (ECS Payment) is then
  // displayed as (approved Conveyance Allowance) - (approved Deduction).
  const isApproved = (info: Record<string, string>) =>
    (info['Authorisation :'] || '').trim().toLowerCase() === 'approved';
  let convTotal = 0;
  let dedTotal = 0;
  for (const info of infos) {
    if (!isApproved(info)) continue;
    convTotal += parseNum(info['Conveyance Allowance:']);
    dedTotal += parseNum(info['Deduction :']);
  }
  merged['Conveyance Allowance:'] = String(convTotal);
  merged['Deduction :'] = String(dedTotal);
  // Final Payment = Toll Tax + On Road Work + (approved) Conveyance Allowance
  //                 - (approved) Deduction
  merged['ECS Payment :'] = String(
    parseNum(merged['Toll Tax :']) +
      parseNum(merged['OnRoad Work :']) +
      convTotal -
      dedTotal
  );

  // Diesel liters: sum only ONCE per unique diesel bill no
  const seenBills = new Set<string>();
  const uniqueBillNos: string[] = [];
  let totalLtr = 0;
  let dieselCounted = false;
  for (const info of infos) {
    const bill = (info['For Diesel Bill No. :'] || '').trim();
    const billKey = bill.toUpperCase();
    if (bill && seenBills.has(billKey)) {
      // Same bill no already counted -> do NOT sum this voucher's diesel again
      continue;
    }
    if (bill) {
      seenBills.add(billKey);
      uniqueBillNos.push(bill);
    }
    totalLtr += parseNum(info["Diesel {Ltr's} :"]);
    dieselCounted = true;
  }
  if (dieselCounted) {
    // Round the summed diesel litres to 2 decimal places.
    merged["Diesel {Ltr's} :"] = (Math.round(totalLtr * 100) / 100).toFixed(2);
  }
  if (uniqueBillNos.length > 0) {
    merged['For Diesel Bill No. :'] = uniqueBillNos.join(', ');
  }

  // Route KM's: sum the KM only from APPROVED vouchers, PLUS any extra KM written
  // in ANY voucher's remark (approved or not). Remark format is "EXTRA KM. 80".
  let kmTotal = 0;
  for (const info of infos) {
    if (isApproved(info)) {
      kmTotal += parseNum(info["KM's SUM"]);
    }
    const remark = info['Remark :'] || '';
    for (const m of remark.matchAll(/EXTRA\s*KM\.?\s*(\d+(?:\.\d+)?)/gi)) {
      kmTotal += parseNum(m[1]);
    }
  }
  merged["KM's SUM"] = String(kmTotal);
  // Average = Route KM / Diesel litres
  if (totalLtr > 0) {
    merged['Average :'] = (kmTotal / totalLtr).toFixed(2);
  }

  // Merge party / order-date lines across every voucher (voucher number
  // prefixed, authorized-only, deduped, date-sorted).
  const mergedParty = buildPartyText(infos);
  if (mergedParty) {
    merged['For Party x Ord Date'] = mergedParty;
  } else {
    delete merged['For Party x Ord Date'];
  }

  // Merge remarks from every voucher that has one, tagged with the voucher's
  // trailing number so it's clear which voucher the remark belongs to. When all
  // remarks share the same leading label (the text up to and including the last
  // "}", e.g. "KHARCHI { ECS }"), the label is printed once at the front and only
  // the per-voucher remainder is tagged:
  //   "KHARCHI { ECS } 95661: 2500/- 26/04/26/ | 95506: 2500/- 23/04/26/"
  const remarkEntries: { suffix: string; remark: string }[] = [];
  const seenRemarks = new Set<string>();
  for (const info of infos) {
    const remark = (info['Remark :'] || '').trim();
    if (!remark) continue;
    const vno = (info['Voucher No. :'] || '').trim();
    const suffix = vno.lastIndexOf('-') >= 0 ? vno.slice(vno.lastIndexOf('-') + 1) : vno;
    const dedupeKey = `${suffix}: ${remark}`;
    if (seenRemarks.has(dedupeKey)) continue;
    seenRemarks.add(dedupeKey);
    remarkEntries.push({ suffix, remark });
  }

  if (remarkEntries.length === 0) {
    delete merged['Remark :'];
  } else {
    // Split each remark into a leading label ending in "}" and the remainder.
    const split = remarkEntries.map((e) => {
      const m = e.remark.match(/^(.*\})\s*(.*)$/s);
      return m
        ? { ...e, label: m[1].trim(), rest: m[2].trim() }
        : { ...e, label: '', rest: e.remark };
    });
    const commonLabel = split[0].label;
    const shareLabel =
      remarkEntries.length > 1 &&
      commonLabel !== '' &&
      split.every((s) => s.label === commonLabel);

    if (shareLabel) {
      const body = split
        .map((s) => (s.suffix ? `${s.suffix}: ${s.rest}` : s.rest))
        .join(' | ');
      merged['Remark :'] = `${commonLabel} ${body}`;
    } else {
      merged['Remark :'] = remarkEntries
        .map((e) => (e.suffix ? `${e.suffix}: ${e.remark}` : e.remark))
        .join(' | ');
    }
  }

  // List EVERY merged voucher's number in the Voucher No field, but keep it short:
  // the first number is shown in full, the rest only show the trailing number when
  // they share the same prefix -> "KM2627-AEV-95798, 95799, 95720".
  const voucherNos: string[] = [];
  const seenVoucherNos = new Set<string>();
  for (const info of infos) {
    const vno = (info['Voucher No. :'] || '').trim();
    if (vno && !seenVoucherNos.has(vno.toUpperCase())) {
      seenVoucherNos.add(vno.toUpperCase());
      voucherNos.push(vno);
    }
  }
  if (voucherNos.length > 0) {
    const prefixOf = (v: string) => {
      const i = v.lastIndexOf('-');
      return i >= 0 ? v.slice(0, i + 1) : '';
    };
    const suffixOf = (v: string) => {
      const i = v.lastIndexOf('-');
      return i >= 0 ? v.slice(i + 1) : v;
    };
    // Show the voucher numbers in sorted order: group by prefix, then by the
    // numeric trailing number (falling back to string compare when it isn't
    // numeric) -> "KM2627-AEV-95720, 95798, 95799".
    const suffixNum = (v: string) => {
      const n = parseInt(suffixOf(v).replace(/[^0-9]/g, ''), 10);
      return isNaN(n) ? Number.POSITIVE_INFINITY : n;
    };
    voucherNos.sort((a, b) => {
      const pa = prefixOf(a);
      const pb = prefixOf(b);
      if (pa !== pb) return pa.localeCompare(pb);
      const na = suffixNum(a);
      const nb = suffixNum(b);
      if (na !== nb) return na - nb;
      return suffixOf(a).localeCompare(suffixOf(b));
    });
    const firstPrefix = prefixOf(voucherNos[0]);
    const compact = voucherNos.map((v, idx) =>
      idx === 0 ? v : prefixOf(v) === firstPrefix ? suffixOf(v) : v
    );
    merged['Voucher No. :'] = compact.join(', ');
  }

  return merged;
}

// Driver name as stored on a voucher, checked across the known driver fields.
function getVoucherDriverName(info: Record<string, string>): string {
  return (
    info['Driver - Aadhar Wise Name :'] ||
    info['Driver :'] ||
    info['Link to Driver :'] ||
    info['Link to Driver'] ||
    ''
  ).trim();
}

function getVoucherVehicleNumber(info: Record<string, string>): string {
  // The vehicle number is stored under different property names across the
  // EV / AEV databases, so check every known variant (trailing spaces and
  // colons matter in Notion). "Vehi x Dri :" holds "VEHICLE x DRIVER" so we
  // take only the part before the separator.
  const direct =
    info['For Vehicle '] ||
    info['For Vehicle'] ||
    info['For Vehicle :'] ||
    info['Vehicle No. :'] ||
    info['Vehicle No :'] ||
    info['Vehicle :'] ||
    info['Vehicle'] ||
    '';
  if (direct.trim()) return direct.trim();

  const combined = (info['Vehi x Dri :'] || info['Vehi x Dri'] || '').trim();
  if (combined) {
    // "GJ12AB1234 x MAHESHBHAI" -> "GJ12AB1234"
    return combined.split(/\s*[x×]\s*/i)[0].trim();
  }
  return '';
}

// Splits voucher-info records into groups that share the same vehicle number.
// A voucher number / driver-name search can turn up trips made with different
// vehicles (e.g. same driver, same day, two different trucks); those must never
// be blended into a single merged voucher, so each vehicle gets its own group.
// Order of first appearance is preserved so the "default" group is predictable.
function groupInfosByVehicle(
  infos: Record<string, string>[]
): { vehicleNumber: string; infos: Record<string, string>[] }[] {
  const groups: { vehicleNumber: string; infos: Record<string, string>[] }[] = [];
  const indexByVehicle = new Map<string, number>();

  for (const info of infos) {
    const vehicle = getVoucherVehicleNumber(info);
    const key = vehicle.toUpperCase();
    let idx = indexByVehicle.get(key);
    if (idx === undefined) {
      idx = groups.length;
      indexByVehicle.set(key, idx);
      groups.push({ vehicleNumber: vehicle, infos: [] });
    }
    groups[idx].infos.push(info);
  }

  return groups;
}

// Searches for a voucher by number, scoped to voucherDate. Every filter
// variant (rich_text/title/formula x equals/contains, across both the raw
// and normalized search value) is combined with the date filter and fired
// concurrently -- only the property-type match actually succeeds (the rest
// throw a validation_error), so this trades a handful of parallel requests
// for what would otherwise be up to 12 sequential round-trips. Priority
// order (equals before contains, raw value before normalized) is preserved
// by scanning the resolved results in the original order, not by which
// request finishes first.
async function queryByVoucherNumber(
  notion: Client,
  databaseId: string,
  voucherNumber: string,
  voucherDate: string | null
): Promise<any[]> {
  const searchValues = Array.from(new Set([voucherNumber.trim(), normalizeVoucherValue(voucherNumber)]));
  const dateFilter = buildDateFilter(voucherDate);

  const filtersInPriorityOrder = searchValues.flatMap((value) => [
    { property: 'Voucher No. :', rich_text: { equals: value } },
    { property: 'Voucher No. :', rich_text: { contains: value } },
    { property: 'Voucher No. :', title: { equals: value } },
    { property: 'Voucher No. :', title: { contains: value } },
    { property: 'Voucher No. :', formula: { string: { equals: value } } },
    { property: 'Voucher No. :', formula: { string: { contains: value } } }
  ]).map((filter) => (dateFilter ? { and: [filter, dateFilter] } : filter));

  const resultsByFilter = await Promise.all(
    filtersInPriorityOrder.map((filter) =>
      queryNotionWithRetry(notion, { database_id: databaseId, page_size: 25, filter })
        .then((response) => response.results ?? [])
        .catch((error: any) => {
          if (error?.code === 'validation_error') return [];
          throw error;
        })
    )
  );

  for (const results of resultsByFilter) {
    if (results.length) return results;
  }

  return [];
}

// Extract a single "best" text value out of a Notion property, used only to
// test whether a page matches a free-text lookup value (diesel bill no.,
// order no., driver name) -- shared by findMatchingPage below.
function extractLookupFieldValue(prop: any): string {
  if (prop?.rich_text?.length) return (prop.rich_text as any[]).map((t) => t.plain_text).join('');
  if (prop?.title?.length) return (prop.title as any[]).map((t) => t.plain_text).join('');
  if (prop?.formula?.string) return prop.formula.string;
  if (prop?.formula?.number) return prop.formula.number.toString();
  if (prop?.number) return prop.number.toString();
  if (prop?.select?.name) return prop.select.name;
  return '';
}

// Paginate a database looking for the first page containing targetValue in
// any property, stopping as soon as a match is found (or maxBatches is hit).
// Used for diesel-bill / order / driver lookups, which aren't date-scoped.
async function findMatchingPage(
  notion: Client,
  databaseId: string,
  targetValue: string,
  maxBatches: number,
  pageSize: number
): Promise<any | null> {
  let cursor: string | undefined = undefined;
  let hasMore = true;
  let batches = 0;

  while (hasMore && batches < maxBatches) {
    const response = await queryNotionWithRetry(notion, {
      database_id: databaseId,
      page_size: pageSize,
      start_cursor: cursor
    });
    batches++;

    const match = (response.results as any[]).find((page: any) => {
      if (!('properties' in page)) return false;
      return Object.values(page.properties).some((value) => {
        const fieldValue = extractLookupFieldValue(value);
        return fieldValue && (fieldValue === targetValue || fieldValue.includes(targetValue));
      });
    });
    if (match) return match;

    hasMore = response.has_more;
    cursor = response.next_cursor || undefined;
  }

  return null;
}

// Build the { propertyName: displayValue } map used for diesel bill / order /
// driver detail side-panels (no alias resolution needed, unlike buildVoucherInfo).
function extractDisplayProperties(properties: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    const prop = value as any;
    let displayValue = '';
    switch (prop.type) {
      case 'title':
      case 'rich_text':
        // Notion splits a single text value into multiple rich_text "runs"
        // whenever part of it is styled differently (colour, bold, a link).
        // Reading only run [0] truncates values like "228 {GJ-15-AX-7255}"
        // to "228 {", so concatenate every run's plain_text.
        displayValue = (prop[prop.type] as any[] | undefined)?.map((t) => t.plain_text).join('') || '';
        break;
      case 'date':
        if (prop.date?.start) {
          const date = new Date(prop.date.start);
          displayValue = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
        }
        break;
      case 'select':
        displayValue = prop.select?.name || '';
        break;
      case 'number':
        displayValue = prop.number?.toString() || '';
        break;
      case 'formula':
        if (prop.formula?.string) {
          displayValue = prop.formula.string;
        } else if (prop.formula?.number) {
          displayValue = prop.formula.number.toString();
        }
        break;
      case 'phone_number':
        displayValue = prop.phone_number || '';
        break;
    }
    if (displayValue) result[key] = displayValue;
  }
  return result;
}

// Paginate one expense-voucher database, scoped to voucherDate, collecting
// every voucher whose driver name contains `query`. Also captures the
// plant/status off the FIRST match found in this database, so callers
// scanning multiple databases can combine results while still preferring the
// earliest database's plant/status.
async function findDriverVouchers(
  notion: Client,
  databaseId: string,
  query: string,
  voucherDate: string | null,
  maxBatches: number
): Promise<{ infos: Record<string, string>[]; firstPlant?: string; firstStatus?: string }> {
  const infos: Record<string, string>[] = [];
  let firstPlant: string | undefined;
  let firstStatus: string | undefined;
  let cursor: string | undefined = undefined;
  let hasMore = true;
  let batches = 0;
  const dateFilter = buildDateFilter(voucherDate);

  while (hasMore && batches < maxBatches) {
    const resp = await queryNotionWithRetry(notion, {
      database_id: databaseId,
      page_size: 100,
      start_cursor: cursor,
      ...(dateFilter ? { filter: dateFilter } : {}),
      sorts: [{ timestamp: 'created_time', direction: 'descending' }]
    });
    batches++;

    for (const page of resp.results as any[]) {
      if (!('properties' in page)) continue;
      const info = buildVoucherInfo(page.properties);
      const driver = getVoucherDriverName(info);
      if (!driver || !driver.toLowerCase().includes(query)) continue;

      if (firstPlant === undefined) {
        const p = page.properties;
        firstPlant = p['Plant']?.select?.name || p['Stk Plant :']?.select?.name || 'INDORE';
        firstStatus = p['Finny Status :']?.status?.name || p['Finny Status :']?.select?.name || 'Unknown';
      }
      infos.push(info);
    }

    hasMore = resp.has_more;
    cursor = resp.next_cursor || undefined;
  }

  if (hasMore && batches >= maxBatches) {
    console.warn(
      `⚠️ Driver search hit batch cap (${maxBatches}) for db ${databaseId}; some vouchers for "${query}" on ${dateScopeLabel(voucherDate)} may not have been included.`
    );
  }

  return { infos, firstPlant, firstStatus };
}

// Paginate the expense-voucher database, scoped to voucherDate, looking for
// OTHER vouchers (excluding excludeId) that share the same driver as the base
// voucher, so they can be merged into one printout.
async function findMergeSiblings(
  notion: Client,
  databaseId: string,
  baseDriverKey: string,
  voucherDate: string | null,
  excludeId: string,
  maxBatches: number
): Promise<Record<string, string>[]> {
  const siblings: Record<string, string>[] = [];
  let cursor: string | undefined = undefined;
  let hasMore = true;
  let batches = 0;
  const dateFilter = buildDateFilter(voucherDate);

  while (hasMore && batches < maxBatches) {
    const resp = await queryNotionWithRetry(notion, {
      database_id: databaseId,
      page_size: 100,
      start_cursor: cursor,
      ...(dateFilter ? { filter: dateFilter } : {}),
      sorts: [{ timestamp: 'created_time', direction: 'descending' }]
    });
    batches++;

    for (const page of resp.results as any[]) {
      if (page.id === excludeId) continue;
      if (!('properties' in page)) continue;
      const info = buildVoucherInfo(page.properties);
      if (getVoucherDriverName(info).toLowerCase() === baseDriverKey) {
        siblings.push(info);
      }
    }

    hasMore = resp.has_more;
    cursor = resp.next_cursor || undefined;
  }

  if (hasMore && batches >= maxBatches) {
    console.warn(
      `⚠️ Merge scan hit batch cap (${maxBatches}); some sibling vouchers may not have been merged.`
    );
  }

  return siblings;
}

// Paginates the driver database once, start to finish, and returns every
// display name. This is the slow part (up to 10 sequential Notion calls) --
// getDriverNameList below exists specifically to make sure a real user's
// request almost never has to wait on this directly.
async function fetchDriverNameList(notion: Client, driverDatabaseId: string): Promise<string[]> {
  const names = new Set<string>();
  let cursor: string | undefined = undefined;
  let hasMore = true;
  let batches = 0;
  const MAX_BATCHES = 10; // up to ~1000 drivers

  while (hasMore && batches < MAX_BATCHES) {
    const resp = await queryNotionWithRetry(notion, {
      database_id: driverDatabaseId,
      page_size: 100,
      start_cursor: cursor
    });
    batches++;

    for (const page of resp.results as any[]) {
      if (!('properties' in page)) continue;
      const titleProp = Object.values(page.properties).find((p: any) => p.type === 'title') as any;
      const name = titleProp?.title?.map((t: any) => t.plain_text || '').join('').trim();
      if (name) names.add(name);
    }

    hasMore = resp.has_more;
    cursor = resp.next_cursor || undefined;
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

// In-flight refresh, shared across callers so a cold cache (or an expired
// one) never triggers more than one concurrent full scan of the driver DB.
let driverNameListRefreshPromise: Promise<string[]> | null = null;

function refreshDriverNameListInBackground(notion: Client, driverDatabaseId: string): Promise<string[]> {
  if (!driverNameListRefreshPromise) {
    driverNameListRefreshPromise = fetchDriverNameList(notion, driverDatabaseId)
      .then((names) => {
        driverNameListCache = { names, timestamp: Date.now() };
        return names;
      })
      .catch((err) => {
        console.error('👤 Driver-list refresh failed:', err);
        // Keep serving whatever was cached before; don't let a failed
        // refresh wipe out a previously-good list.
        return driverNameListCache?.names ?? [];
      })
      .finally(() => {
        driverNameListRefreshPromise = null;
      });
  }
  return driverNameListRefreshPromise;
}

// Fetch (and cache) the driver master list's display names, used to power
// the search-bar autocomplete. Stale-while-revalidate: once warm, a request
// NEVER waits on Notion -- an expired cache is still served immediately
// while a fresh copy is fetched in the background for next time. Only a
// true cold start (nothing cached yet, e.g. right after a server restart
// before the warm-up below has finished) blocks on the full scan.
function getDriverNameList(notion: Client, driverDatabaseId: string): Promise<string[]> {
  if (!driverNameListCache) {
    return refreshDriverNameListInBackground(notion, driverDatabaseId);
  }

  const isStale = (Date.now() - driverNameListCache.timestamp) >= DRIVER_LIST_CACHE_DURATION;
  if (isStale) {
    refreshDriverNameListInBackground(notion, driverDatabaseId); // fire and forget
  }
  return Promise.resolve(driverNameListCache.names);
}

// Warm the cache shortly after the server boots, so the FIRST real user to
// open the search bar already finds it populated instead of paying for the
// full driver-list scan themselves. Deferred via setImmediate so it runs
// after the rest of the module graph (env vars included) has finished
// loading, regardless of import order.
setImmediate(() => {
  const driverDatabaseId = process.env.DRIVER_DATABASE_ID;
  if (!driverDatabaseId) return;
  const notion = new Client({
    auth: process.env.NOTION_INTEGRATION_SECRET,
    timeoutMs: 120000
  });
  refreshDriverNameListInBackground(notion, driverDatabaseId).catch((err) => {
    console.error('👤 Driver-list warm-up failed:', err);
  });
});

// Driver-name autocomplete for the search bar. Filters the cached driver
// master list in memory, so typing never triggers a fresh Notion query.
router.get('/expense-voucher/driver-suggestions', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim().toLowerCase();
    const DRIVER_DATABASE_ID = process.env.DRIVER_DATABASE_ID;

    if (!DRIVER_DATABASE_ID) {
      return res.status(500).json({
        success: false,
        message: 'DRIVER_DATABASE_ID environment variable is not set',
        suggestions: []
      });
    }

    const notion = new Client({
      auth: process.env.NOTION_INTEGRATION_SECRET,
      timeoutMs: 30000
    });

    const allNames = await getDriverNameList(notion, DRIVER_DATABASE_ID);
    const suggestions = query
      ? allNames.filter((name) => name.toLowerCase().includes(query)).slice(0, 10)
      : allNames.slice(0, 10);

    return res.json({ success: true, suggestions });
  } catch (error: any) {
    console.error('👤 Error fetching driver suggestions:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch driver suggestions',
      suggestions: []
    });
  }
});

// Expense voucher API - Protected
router.post('/expense-voucher', requirePageAccess('expense-voucher'), async (req, res) => {
  try {
    const { orderNumber, driverName } = req.body;
    // The date is optional: a valid YYYY-MM-DD scopes the search to that day,
    // otherwise voucherDate is null and the search spans all dates.
    const voucherDate = normalizeVoucherDate(req.body?.voucherDate);

    if (!orderNumber && !driverName) {
      return res.status(400).json({
        success: false,
        message: 'Voucher number or driver name is required'
      });
    }

    // Check cache first (date is part of the key since results are scoped to it)
    const cacheKey = driverName
      ? `expense_voucher_driver_${String(driverName).trim().toUpperCase()}_${voucherDate ?? 'ALL'}`
      : `expense_voucher_${orderNumber}_${voucherDate ?? 'ALL'}`;
    const cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      // Cache hit
      return res.json(cached.data);
    }

    // Increase Notion client timeout to 60 seconds to reduce timeout errors
    const notion = new Client({
      auth: process.env.NOTION_INTEGRATION_SECRET,
      timeoutMs: 120000 // 60 seconds
    });

    // Extract database ID from the provided URL: https://www.notion.so/kmfinny/173604c4adf080f7853dc9a41a8a69a9?v=173604c4adf08158ba8a000c964da041&source=copy_link
    const EXPENSE_VOUCHER_DATABASE_ID = process.env.EXPENSE_VOUCHER_DATABASE_ID;

    const AEV_EXPENSE_DATABASE_ID = process.env.AEV_EXPENSE_VOUCHER_DATABASE_ID;
    // Diesel bill database ID from: https://www.notion.so/kmfinny/dfba335ed74d4cd991b5b1a597c90605?v=a1866200419647f898d21f0fb6983a47&source=copy_link
    const DIESEL_BILL_DATABASE_ID = process.env.DIESEL_BILL_DATABASE_ID;

    // Order details database ID from: https://www.notion.so/kmfinny/296851d9af9e4a14966376e58f8475e5?v=71fd049ebcc042dba43cc985ac6520a0&source=copy_link
    const ORDER_DETAILS_DATABASE_ID = process.env.ORDER_DATABASE_ID;

    // Driver database ID from: https://www.notion.so/kmfinny/7ac590de16e645cb96478236d5c47618?v=af0c988b17994ba7b7bdcce02f0a0cc2&source=copy_link
    const DRIVER_DATABASE_ID = process.env.DRIVER_DATABASE_ID;

    const PARTY_DATABASE_ID = process.env.PARTY_DATABASE_ID;

    if (!EXPENSE_VOUCHER_DATABASE_ID) {
      return res.status(500).json({
        success: false,
        message: 'EXPENSE_VOUCHER_DATABASE_ID environment variable is not set'
      });
    }
    if (!AEV_EXPENSE_DATABASE_ID) {
    return res.status(500).json({
        success: false,
        message: "AEV_EXPENSE_VOUCHER_DATABASE_ID is missing"
    });
    }
    if (!DIESEL_BILL_DATABASE_ID) {
      return res.status(500).json({
        success: false,
        message: 'DIESEL_BILL_DATABASE_ID environment variable is not set'
      });
    }
    if (!ORDER_DETAILS_DATABASE_ID) {
      return res.status(500).json({
        success: false,
        message: 'ORDER_DETAILS_DATABASE_ID environment variable is not set'
      });
    }
    if (!DRIVER_DATABASE_ID) {
      return res.status(500).json({
        success: false,
        message: 'DRIVER_DATABASE_ID environment variable is not set'
      });
    }
    if (!PARTY_DATABASE_ID) {
      return res.status(500).json({
        success: false,
        message: 'PARTY_DATABASE_ID environment variable is not set'
      });
    }

    // ===== DRIVER-NAME SEARCH =====
    // Return ALL of that driver's vouchers on voucherDate merged into one
    // voucher (same output shape as a voucher-number search, so the client
    // view / print are reused).
    if (driverName) {
      const query = String(driverName).trim().toLowerCase();
      const databases = [EXPENSE_VOUCHER_DATABASE_ID];
      if (AEV_EXPENSE_DATABASE_ID) databases.push(AEV_EXPENSE_DATABASE_ID);

      // Scan every database concurrently instead of one after another --
      // "first match wins" for plant/status is preserved by preferring the
      // earliest database in `databases` that produced any match, not by
      // whichever database's scan happens to finish first.
      const perDbResults = await Promise.all(
        databases.map((dbId) =>
          findDriverVouchers(notion, dbId, query, voucherDate, 10).catch((dbError: any) => {
            console.error(
              `👤 Driver search failed for database ${dbId}:`,
              dbError?.code || dbError?.status || '',
              dbError?.message || dbError
            );
            // Continue with the remaining databases instead of failing the request.
            return { infos: [] as Record<string, string>[], firstPlant: undefined, firstStatus: undefined };
          })
        )
      );

      const infos: Record<string, string>[] = perDbResults.flatMap((r) => r.infos);
      let firstPlant = 'INDORE';
      let firstStatus = 'Unknown';
      const firstMatchDb = perDbResults.find((r) => r.firstPlant !== undefined);
      if (firstMatchDb) {
        firstPlant = firstMatchDb.firstPlant!;
        firstStatus = firstMatchDb.firstStatus!;
      }

      if (infos.length === 0) {
        return res.status(404).json({
          success: false,
          message: `No vouchers found for driver "${driverName}" on ${dateScopeLabel(voucherDate)}`
        });
      }

      // Different vehicles for the same driver are kept as separate vouchers
      // instead of being blended together; the client shows a dropdown to
      // switch between them when more than one vehicle is found.
      console.log(
        `🚚 Driver "${driverName}" on ${voucherDate} vehicle values:`,
        infos.map((info) => ({
          vehicle: getVoucherVehicleNumber(info),
          voucherNo: info['Voucher No. :'] || ''
        }))
      );

      const vehicleGroups = groupInfosByVehicle(infos);
      const vehicleOptions = vehicleGroups.map((g) => ({
        vehicleNumber: g.vehicleNumber || 'Unknown',
        voucherInfo: mergeVoucherInfos(g.infos),
        mergedVoucherCount: g.infos.length
      }));

      console.log(
        vehicleOptions.length > 1
          ? `🔗 Driver "${driverName}": ${infos.length} voucher(s) found across ${vehicleOptions.length} distinct vehicles: ${vehicleOptions.map((o) => o.vehicleNumber).join(', ')}`
          : `🔗 Driver "${driverName}": merging ${infos.length} voucher(s) into one printout (single vehicle: ${vehicleOptions[0]?.vehicleNumber})`
      );

      const driverData: any = {
        orderNumber: String(driverName),
        plant: firstPlant,
        status: firstStatus,
        items: [],
        voucherInfo: vehicleOptions[0].voucherInfo,
        mergedVoucherCount: vehicleOptions[0].mergedVoucherCount
      };
      if (vehicleOptions.length > 1) {
        driverData.vehicleOptions = vehicleOptions;
      }

      const driverResult = {
        success: true,
        message: `${infos.length} voucher(s) merged for driver ${driverName} on ${dateScopeLabel(voucherDate)}`,
        data: driverData,
        itemCount: 0
      };

      searchCache.set(cacheKey, { data: driverResult, timestamp: Date.now() });
      return res.json(driverResult);
    }

    const voucherNo = String(orderNumber).trim().toUpperCase();

    const expenseVoucherDatabaseId =
      voucherNo.includes("AEV")
        ? AEV_EXPENSE_DATABASE_ID
        : EXPENSE_VOUCHER_DATABASE_ID;

    try {
      console.log(`🔍 Searching for voucher: ${orderNumber} on ${voucherDate}`);
      let matchingResults: any[] = [];
      const normalizedOrderNumber = normalizeVoucherValue(String(orderNumber));

      try {
        const directMatches = await queryByVoucherNumber(
          notion,
          expenseVoucherDatabaseId,
          String(orderNumber),
          voucherDate
        );
        if (directMatches.length > 0) {
          matchingResults = directMatches;
          console.log(`Direct filter matched ${directMatches.length} record(s).`);
        }

        if (matchingResults.length === 0) {
          // Fallback: Notion's date filter narrows the scan to just this
          // date's records (instead of paginating hundreds of historical
          // vouchers), then match the voucher number exactly in JS -- covers
          // property-type quirks the direct filters above can miss.
          console.log(`📅 Fetching records for ${voucherDate} (newest first)...`);
          let hasMore = true;
          let cursor: string | undefined = undefined;
          let batchCount = 0;
          const MAX_BATCHES = 10;
          const dateFilter = buildDateFilter(voucherDate);

          while (hasMore && batchCount < MAX_BATCHES && matchingResults.length === 0) {
            const response = await queryNotionWithRetry(notion, {
              database_id: expenseVoucherDatabaseId,
              page_size: 50,
              start_cursor: cursor,
              ...(dateFilter ? { filter: dateFilter } : {}),
              sorts: [
                {
                  timestamp: 'created_time',
                  direction: 'descending'
                }
              ]
            });
            batchCount++;
            const batchResults = response.results;
            console.log(`📄 Batch ${batchCount}: Fetched ${batchResults.length} records`);

            // Search THIS batch immediately for early exit
            const batchMatches = batchResults.filter((page: any) => {
              if (!('properties' in page)) return false;
              const properties = page.properties;
              // Check ALL fields for the voucher number
              for (const [key, value] of Object.entries(properties)) {
                const prop = value as any;
                let fieldValue = '';
                // FIX: Join ALL text parts. Notion splits text if formatting changes
                if (prop.rich_text && Array.isArray(prop.rich_text)) {
                  fieldValue = prop.rich_text.map((t: any) => t.plain_text).join('');
                } else if (prop.title && Array.isArray(prop.title)) {
                  fieldValue = prop.title.map((t: any) => t.plain_text).join('');
                } else if (prop.formula?.string) {
                  fieldValue = prop.formula.string;
                } else if (prop.formula?.number) {
                  fieldValue = prop.formula.number.toString();
                } else if (prop.number) {
                  fieldValue = prop.number.toString();
                } else if (prop.select?.name) {
                  fieldValue = prop.select.name;
                }
                // Check for exact match ONLY
                // If searching for "6417", we do NOT want "6417A"
                if (fieldValue && normalizeVoucherValue(fieldValue) === normalizedOrderNumber) {
                  return true;
                }
              }
              return false;
            });
            if (batchMatches.length > 0) {
              console.log(`✅ FOUND in batch ${batchCount}! Stopping search.`);
              matchingResults = batchMatches;
              break; // Early exit - found it!
            }
            hasMore = response.has_more;
            cursor = response.next_cursor || undefined;
          }
        }
        console.log(`✅ Search complete: ${matchingResults.length} matches found`);
      } catch (error: any) {
        console.error('📋 Error fetching expense voucher data:', error);
        if ([502, 503, 504].includes(error?.status)) {
          return res.status(503).json({
            success: false,
            message: 'Notion service is temporarily unavailable. Please retry in a few seconds.'
          });
        }
        return res.status(500).json({
          success: false,
          message: 'Failed to fetch expense voucher data'
        });
      }

      // Check if we found any matches
      if (matchingResults.length === 0) {
        console.log(`No voucher match for input raw="${orderNumber}", normalized="${normalizedOrderNumber}" on ${voucherDate}`);
        return res.status(404).json({
          success: false,
          message: `Voucher ${orderNumber} not found in expense voucher database on ${dateScopeLabel(voucherDate)}`
        });
      }

      // Process first matching result
      const firstMatch = matchingResults[0] as any;
      const properties = firstMatch.properties;

      const expenseVoucherData: any = {
        orderNumber: orderNumber,
        plant: properties['Plant']?.select?.name || properties['Stk Plant :']?.select?.name || 'INDORE',
        status: properties['Finny Status :']?.status?.name || properties['Finny Status :']?.select?.name || 'Unknown',
        items: [],
        voucherInfo: {} as any
      };

      // Extract all property data from expense voucher record
      expenseVoucherData.voucherInfo = buildVoucherInfo(properties);

      // Fetch diesel bill / order / driver detail lookups AND scan for sibling
      // vouchers to merge. These four reads are all independent of each other
      // (they only depend on the already-fetched base voucher's properties),
      // but used to run one after another; running them concurrently cuts
      // wall-clock time down to the slowest single lookup instead of their sum.
      const dieselBillNo = expenseVoucherData.voucherInfo['For Diesel Bill No. :'];
      const relatedOrderNumber = expenseVoucherData.voucherInfo['ORD{25-26-Current}'] || expenseVoucherData.voucherInfo['Order-Date :'];
      const driverNameForLookup = expenseVoucherData.voucherInfo['Link to Driver'] || expenseVoucherData.voucherInfo['Driver :'] || expenseVoucherData.voucherInfo['Driver - Aadhar Wise Name :'];
      const baseInfo = expenseVoucherData.voucherInfo as Record<string, string>;
      const baseDriver = getVoucherDriverName(baseInfo);

      const [dieselBillDetails, orderDetails, driverDetails, mergeSiblings] = await Promise.all([
        dieselBillNo
          ? findMatchingPage(notion, DIESEL_BILL_DATABASE_ID, dieselBillNo, 1, 50)
              .then((page) => (page ? extractDisplayProperties(page.properties) : null))
              .catch(() => null) // Silently handle diesel error
          : Promise.resolve(null),
        relatedOrderNumber
          ? findMatchingPage(notion, ORDER_DETAILS_DATABASE_ID, relatedOrderNumber, 3, 100)
              .then((page) => (page ? extractDisplayProperties(page.properties) : null))
              .catch((err) => {
                console.error('📦 Error fetching order details:', err);
                return null;
              })
          : Promise.resolve(null),
        driverNameForLookup
          ? findMatchingPage(notion, DRIVER_DATABASE_ID, driverNameForLookup, 3, 100)
              .then((page) => (page ? extractDisplayProperties(page.properties) : null))
              .catch((err) => {
                console.error('👤 Error fetching driver details:', err);
                return null;
              })
          : Promise.resolve(null),
        baseDriver
          ? findMergeSiblings(notion, expenseVoucherDatabaseId, baseDriver.toLowerCase(), voucherDate, firstMatch.id, 10)
              .catch((err) => {
                console.error('🔗 Error merging same driver/date vouchers:', err);
                return [] as Record<string, string>[];
              })
          : Promise.resolve([] as Record<string, string>[])
      ]);

      // Add all additional details to the expense voucher data
      if (dieselBillDetails) {
        expenseVoucherData.dieselBillDetails = dieselBillDetails;
      }
      if (orderDetails) {
        expenseVoucherData.orderDetails = orderDetails;
      }
      if (driverDetails) {
        expenseVoucherData.driverDetails = driverDetails;
      }

      // ===== Merge vouchers with the SAME driver name on voucherDate =====
      // All such vouchers are combined into one printout:
      //  - Expense amounts (Toll, OnRoad, Conveyance, Deduction, ECS, Amount) are
      //    summed across every voucher.
      //  - Diesel liters and Route KM's are summed only ONCE per UNIQUE diesel bill
      //    no. If two vouchers share the same bill no, the duplicate is NOT re-added.
      if (mergeSiblings.length > 0) {
        const candidateInfos: Record<string, string>[] = [baseInfo, ...mergeSiblings];

        console.log(
          `🚚 Voucher-number siblings (${candidateInfos.length}) on ${voucherDate} vehicle values:`,
          candidateInfos.map((info) => ({
            vehicle: getVoucherVehicleNumber(info),
            voucherNo: info['Voucher No. :'] || ''
          }))
        );

        // Same driver + same date but different vehicles (e.g. two trucks
        // dispatched the same day) must stay separate vouchers; default to
        // the vehicle the user actually searched for and offer the rest
        // as dropdown options.
        const vehicleGroups = groupInfosByVehicle(candidateInfos);
        if (vehicleGroups.length > 1) {
          const vehicleOptions = vehicleGroups.map((g) => ({
            vehicleNumber: g.vehicleNumber || 'Unknown',
            voucherInfo: mergeVoucherInfos(g.infos),
            mergedVoucherCount: g.infos.length
          }));
          const baseVehicle = getVoucherVehicleNumber(baseInfo).toUpperCase();
          const defaultIdx = Math.max(
            0,
            vehicleGroups.findIndex((g) => g.vehicleNumber.toUpperCase() === baseVehicle)
          );
          console.log(
            `🔗 Driver "${baseDriver}" on ${voucherDate}: ${vehicleGroups.length} distinct vehicles found; keeping them separate`
          );
          expenseVoucherData.voucherInfo = vehicleOptions[defaultIdx].voucherInfo;
          expenseVoucherData.mergedVoucherCount = vehicleOptions[defaultIdx].mergedVoucherCount;
          expenseVoucherData.vehicleOptions = vehicleOptions;
        } else {
          console.log(
            `🔗 Merging ${candidateInfos.length} vouchers for driver "${baseDriver}" on ${voucherDate}`
          );
          expenseVoucherData.voucherInfo = mergeVoucherInfos(candidateInfos);
          expenseVoucherData.mergedVoucherCount = candidateInfos.length;
        }
      }

      const result = {
        success: true,
        message: `Voucher ${orderNumber} found`,
        data: expenseVoucherData,
        itemCount: 0
      };

      // Cache the successful result
      searchCache.set(cacheKey, { data: result, timestamp: Date.now() });

      return res.json(result);

    } catch (error) {
      console.error('📋 Error in expense voucher search:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to search expense voucher database'
      });
    }

  } catch (error) {
    console.error('📋 Error in expense voucher route:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }

});

export default router;
