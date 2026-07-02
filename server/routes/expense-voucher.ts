import { Router } from 'express';
import { Client } from '@notionhq/client';
import { authenticateToken } from '../middleware/authMiddleware'; // Import middleware

const router = Router();

// Simple in-memory cache to speed up repeated searches
const searchCache = new Map<string, { data: any, timestamp: number }>();
const partyCache = new Map<string, { data: any, timestamp: number }>();
const CACHE_DURATION = (60 * 1000)/2; // 1 hour cache for maximum speed

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

function extractVoucherNoFromPage(page: any): string {
  const prop = page?.properties?.['Voucher No. :'];
  if (!prop) return '';
  if (prop.rich_text && Array.isArray(prop.rich_text)) {
    return prop.rich_text.map((t: any) => t.plain_text || '').join('');
  }
  if (prop.title && Array.isArray(prop.title)) {
    return prop.title.map((t: any) => t.plain_text || '').join('');
  }
  if (prop.formula?.string) {
    return prop.formula.string;
  }
  if (typeof prop.number === 'number') {
    return String(prop.number);
  }
  return '';
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
        displayValue = prop[prop.type]?.[0]?.plain_text || '';
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
          if (firstItem?.rich_text?.[0]?.plain_text) {
            displayValue = firstItem.rich_text[0].plain_text;
          } else if (firstItem?.title?.[0]?.plain_text) {
            displayValue = firstItem.title[0].plain_text;
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
  // trailing number so it's clear which voucher the remark belongs to.
  const remarkLines: string[] = [];
  const seenRemarks = new Set<string>();
  for (const info of infos) {
    const remark = (info['Remark :'] || '').trim();
    if (!remark) continue;
    const vno = (info['Voucher No. :'] || '').trim();
    const suffix = vno.lastIndexOf('-') >= 0 ? vno.slice(vno.lastIndexOf('-') + 1) : vno;
    const line = suffix ? `${suffix}: ${remark}` : remark;
    if (!seenRemarks.has(line)) {
      seenRemarks.add(line);
      remarkLines.push(line);
    }
  }
  if (remarkLines.length > 0) {
    merged['Remark :'] = remarkLines.join(' | ');
  } else {
    delete merged['Remark :'];
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

async function queryByVoucherNumber(
  notion: Client,
  databaseId: string,
  voucherNumber: string
): Promise<any[]> {
  const searchValues = Array.from(new Set([voucherNumber.trim(), normalizeVoucherValue(voucherNumber)]));

  for (const value of searchValues) {
    const filters = [
      { property: 'Voucher No. :', rich_text: { equals: value } },
      { property: 'Voucher No. :', rich_text: { contains: value } },
      { property: 'Voucher No. :', title: { equals: value } },
      { property: 'Voucher No. :', title: { contains: value } },
      { property: 'Voucher No. :', formula: { string: { equals: value } } },
      { property: 'Voucher No. :', formula: { string: { contains: value } } }
    ];

    for (const filter of filters) {
      try {
        const response = await queryNotionWithRetry(notion, {
          database_id: databaseId,
          page_size: 25,
          filter
        });

        if (response.results?.length) {
          return response.results;
        }
      } catch (error: any) {
        if (error?.code === 'validation_error') {
          continue;
        }
        throw error;
      }
    }
  }

  return [];
}

// Expense voucher API - Protected
router.post('/expense-voucher', async (req, res) => {
  try {
    const { orderNumber, driverName } = req.body;

    if (!orderNumber && !driverName) {
      return res.status(400).json({
        success: false,
        message: 'Voucher number or driver name is required'
      });
    }

    // Check cache first
    const cacheKey = driverName
      ? `expense_voucher_driver_${String(driverName).trim().toUpperCase()}`
      : `expense_voucher_${orderNumber}`;
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
    // Return ALL of that driver's vouchers merged into one voucher (same output
    // shape as a voucher-number search, so the client view / print are reused).
    if (driverName) {
      const query = String(driverName).trim().toLowerCase();
      const databases = [EXPENSE_VOUCHER_DATABASE_ID];
      if (AEV_EXPENSE_DATABASE_ID) databases.push(AEV_EXPENSE_DATABASE_ID);

      const infos: Record<string, string>[] = [];
      let firstPlant = 'INDORE';
      let firstStatus = 'Unknown';
      let gotFirst = false;

      for (const dbId of databases) {
        try {
          let cursor: string | undefined = undefined;
          let hasMore = true;
          let batches = 0;
          const MAX_BATCHES = 10; // scan up to ~1000 recent records per database

          while (hasMore && batches < MAX_BATCHES) {
            const resp = await queryNotionWithRetry(notion, {
              database_id: dbId,
              page_size: 100,
              start_cursor: cursor,
              sorts: [{ timestamp: 'created_time', direction: 'descending' }]
            });
            batches++;

            for (const page of resp.results as any[]) {
              if (!('properties' in page)) continue;
              const info = buildVoucherInfo(page.properties);
              const driver = getVoucherDriverName(info);
              if (!driver || !driver.toLowerCase().includes(query)) continue;

              if (!gotFirst) {
                const p = page.properties;
                firstPlant =
                  p['Plant']?.select?.name ||
                  p['Stk Plant :']?.select?.name ||
                  'INDORE';
                firstStatus =
                  p['Finny Status :']?.status?.name ||
                  p['Finny Status :']?.select?.name ||
                  'Unknown';
                gotFirst = true;
              }
              infos.push(info);
            }

            hasMore = resp.has_more;
            cursor = resp.next_cursor || undefined;

            if (hasMore && batches >= MAX_BATCHES) {
              console.warn(
                `⚠️ Driver search hit batch cap (${MAX_BATCHES}) for db ${dbId}; older vouchers for "${query}" were not merged.`
              );
            }
          }
        } catch (dbError: any) {
          console.error(
            `👤 Driver search failed for database ${dbId}:`,
            dbError?.code || dbError?.status || '',
            dbError?.message || dbError
          );
          // Continue with the remaining databases instead of failing the request.
        }
      }

      if (infos.length === 0) {
        return res.status(404).json({
          success: false,
          message: `No vouchers found for driver "${driverName}"`
        });
      }

      // Different vehicles for the same driver are kept as separate vouchers
      // instead of being blended together; the client shows a dropdown to
      // switch between them when more than one vehicle is found.
      // DEBUG: log the vehicle value read from every matched voucher so we can
      // see why the grouping did / didn't split into multiple vehicles.
      console.log(
        `🚚 Driver "${driverName}" vehicle values:`,
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
        message: `${infos.length} voucher(s) merged for driver ${driverName}`,
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

      // Simple query without any filters
      // Fetching records
      
      // Fetch records with smart batching and early exit
      console.log(`🔍 Searching for voucher: ${orderNumber}`);
      let allResults: any[] = [];
      let matchingResults: any[] = [];
      const normalizedOrderNumber = normalizeVoucherValue(String(orderNumber));
      
      try {
        console.log(`Trying direct Notion filter for voucher: ${normalizedOrderNumber}`);
        const directMatches = await queryByVoucherNumber(
          notion,
          expenseVoucherDatabaseId,
          String(orderNumber)
        );
        if (directMatches.length > 0) {
          matchingResults = directMatches;
          console.log(`Direct filter matched ${directMatches.length} record(s).`);
          console.log(
            'Direct filter Voucher No. samples:',
            directMatches.slice(0, 5).map((page: any) => {
              const raw = extractVoucherNoFromPage(page);
              return { raw, normalized: normalizeVoucherValue(raw) };
            })
          );
        }

        if (matchingResults.length === 0) {
        // TODO: Optimize this query by using Notion API filters if possible to avoid fetching all records and reduce timeouts.
        // Fetch in small batches and check after each batch (early exit when found)
        console.log(`📅 Fetching recent records (newest first)...`);
        let hasMore = true;
        let cursor: string | undefined = undefined;
        let batchCount = 0;
        const MAX_BATCHES = 10; // Fallback scan up to 500 recent records
        while (hasMore && batchCount < MAX_BATCHES && matchingResults.length === 0) {
          const response = await queryNotionWithRetry(notion, {
            database_id: expenseVoucherDatabaseId,
            page_size: 50,
            start_cursor: cursor,
            sorts: [
              {
                timestamp: 'created_time',
                direction: 'descending'
              }
            ]
          });
          batchCount++;
          const batchResults = response.results;
          allResults = allResults.concat(batchResults);
          console.log(
            `Batch ${batchCount} Voucher No. samples:`,
            batchResults.slice(0, 5).map((page: any) => {
              const raw = extractVoucherNoFromPage(page);
              return { raw, normalized: normalizeVoucherValue(raw) };
            })
          );
          console.log(`📄 Batch ${batchCount}: Fetched ${batchResults.length} records, total: ${allResults.length}`);
          // Log property keys from the first record in the first batch for debugging
          if (batchCount === 1 && batchResults.length > 0) {
            const firstProps = batchResults[0].properties;
            console.log('🔑 Property keys in first record:', Object.keys(firstProps));
          }
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
        console.log(`✅ Search complete: ${allResults.length} records checked, ${matchingResults.length} matches found`);
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
        console.log(`No voucher match for input raw="${orderNumber}", normalized="${normalizedOrderNumber}"`);
        console.log(
          'Scanned Voucher No. sample (first 20):',
          allResults.slice(0, 20).map((page: any) => {
            const raw = extractVoucherNoFromPage(page);
            return { raw, normalized: normalizeVoucherValue(raw) };
          })
        );
        return res.status(404).json({
          success: false,
          message: `Voucher ${orderNumber} not found in expense voucher database`
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


      // Fetch related diesel bill details if diesel bill number exists
      let dieselBillDetails = null;
      const dieselBillNo = expenseVoucherData.voucherInfo['For Diesel Bill No. :'];
      
      if (dieselBillNo) {
        try {
          // Search diesel bill database efficiently
          let dieselResponse = await queryNotionWithRetry(notion, {
            database_id: DIESEL_BILL_DATABASE_ID,
            page_size: 50
          });
            
            // Find matching diesel bill record
            const matchingDieselResults = dieselResponse.results.filter((page: any) => {
              if (!('properties' in page)) return false;
              const properties = page.properties;
              
              // Check ALL fields for the diesel bill number
              for (const [key, value] of Object.entries(properties)) {
                const prop = value as any;
                let fieldValue = '';
                
                if (prop.rich_text?.[0]?.plain_text) {
                  fieldValue = prop.rich_text[0].plain_text;
                } else if (prop.title?.[0]?.plain_text) {
                  fieldValue = prop.title[0].plain_text;
                } else if (prop.formula?.string) {
                  fieldValue = prop.formula.string;
                } else if (prop.number) {
                  fieldValue = prop.number.toString();
                } else if (prop.select?.name) {
                  fieldValue = prop.select.name;
                }
                
                if (fieldValue && (fieldValue === dieselBillNo || fieldValue.includes(dieselBillNo))) {
                  return true;
                }
              }
              
              return false;
            });
            
            if (matchingDieselResults.length > 0) {
              const dieselRecord = matchingDieselResults[0] as any;
              const dieselProperties = dieselRecord.properties;
              
              dieselBillDetails = {} as any;
              
              // Extract all property data from diesel bill record
              for (const [key, value] of Object.entries(dieselProperties)) {
                const prop = value as any;
                let displayValue = '';
                
                switch (prop.type) {
                  case 'title':
                  case 'rich_text':
                    displayValue = prop[prop.type]?.[0]?.plain_text || '';
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
                }
                
                if (displayValue) {
                  dieselBillDetails[key] = displayValue;
                }
              }
              
            } else {
            }
            
          } catch (dieselError) {
            // Silently handle diesel error
          }
          
      }
      
      // Fetch related order details if available
      let orderDetails = null;
      const relatedOrderNumber = expenseVoucherData.voucherInfo['ORD{25-26-Current}'] || expenseVoucherData.voucherInfo['Order-Date :'];
      
      if (relatedOrderNumber) {
        try {
          
          let orderResponse;
          try {
            let allOrderResults: any[] = [];
            let orderCursor = undefined;
            let orderBatchCount = 0;
            
            do {
              let orderBatchResponse = await queryNotionWithRetry(notion, {
                database_id: ORDER_DETAILS_DATABASE_ID,
                page_size: 100,
                start_cursor: orderCursor
              });
              
              allOrderResults = allOrderResults.concat(orderBatchResponse.results);
              orderCursor = orderBatchResponse.has_more ? orderBatchResponse.next_cursor : undefined;
              orderBatchCount++;
              
              // Check if we found our target order in this batch
              const foundOrderInBatch = orderBatchResponse.results.some((page: any) => {
                if (!('properties' in page)) return false;
                const props = page.properties;
                
                for (const [key, value] of Object.entries(props)) {
                  const prop = value as any;
                  let fieldValue = '';
                  
                  if (prop.rich_text?.[0]?.plain_text) {
                    fieldValue = prop.rich_text[0].plain_text;
                  } else if (prop.title?.[0]?.plain_text) {
                    fieldValue = prop.title[0].plain_text;
                  } else if (prop.formula?.string) {
                    fieldValue = prop.formula.string;
                  } else if (prop.number) {
                    fieldValue = prop.number.toString();
                  }
                  
                  if (fieldValue && (fieldValue === relatedOrderNumber || fieldValue.includes(relatedOrderNumber))) {
                    return true;
                  }
                }
                return false;
              });
              
              if (foundOrderInBatch) {
                break;
              }
              
            } while (orderCursor && orderBatchCount < 3);
            
            orderResponse = { results: allOrderResults };
            
            const matchingOrderResults = orderResponse.results.filter((page: any) => {
              if (!('properties' in page)) return false;
              const properties = page.properties;
              
              for (const [key, value] of Object.entries(properties)) {
                const prop = value as any;
                let fieldValue = '';
                
                if (prop.rich_text?.[0]?.plain_text) {
                  fieldValue = prop.rich_text[0].plain_text;
                } else if (prop.title?.[0]?.plain_text) {
                  fieldValue = prop.title[0].plain_text;
                } else if (prop.formula?.string) {
                  fieldValue = prop.formula.string;
                } else if (prop.number) {
                  fieldValue = prop.number.toString();
                } else if (prop.select?.name) {
                  fieldValue = prop.select.name;
                }
                
                if (fieldValue && (fieldValue === relatedOrderNumber || fieldValue.includes(relatedOrderNumber))) {
                  return true;
                }
              }
              
              return false;
            });
            
            if (matchingOrderResults.length > 0) {
              const orderRecord = matchingOrderResults[0] as any;
              const orderProperties = orderRecord.properties;
              
              orderDetails = {} as any;
              
              for (const [key, value] of Object.entries(orderProperties)) {
                const prop = value as any;
                let displayValue = '';
                
                switch (prop.type) {
                  case 'title':
                  case 'rich_text':
                    displayValue = prop[prop.type]?.[0]?.plain_text || '';
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
                }
                
                if (displayValue) {
                  orderDetails[key] = displayValue;
                }
              }
              
            }
            
          } catch (orderError) {
            console.error('📦 Error fetching order details:', orderError);
          }
          
        } catch (error) {
          console.error('📦 Error in order details lookup:', error);
        }
      }
      console.log("========== ALL EXPENSE VOUCHER PROPERTIES ==========");

        for (const [key, value] of Object.entries(properties)) {
          console.log("--------------------------------");
          console.log("Property Name:", key);
          console.log("Property Type:", (value as any).type);
          console.dir(value, { depth: null });
        }

        console.log("==============================================");
      // Fetch driver details if available
      let driverDetails = null;
      const driverName = expenseVoucherData.voucherInfo['Link to Driver'] || expenseVoucherData.voucherInfo['Driver :'] || expenseVoucherData.voucherInfo['Driver - Aadhar Wise Name :'];
      
      if (driverName) {
        try {
          
          let driverResponse;
          try {
            let allDriverResults: any[] = [];
            let driverCursor = undefined;
            let driverBatchCount = 0;
            
            do {
              let driverBatchResponse = await queryNotionWithRetry(notion, {
                database_id: DRIVER_DATABASE_ID,
                page_size: 100,
                start_cursor: driverCursor
              });
              
              allDriverResults = allDriverResults.concat(driverBatchResponse.results);
              driverCursor = driverBatchResponse.has_more ? driverBatchResponse.next_cursor : undefined;
              driverBatchCount++;
              
              const foundDriverInBatch = driverBatchResponse.results.some((page: any) => {
                if (!('properties' in page)) return false;
                const props = page.properties;
                
                for (const [key, value] of Object.entries(props)) {
                  const prop = value as any;
                  let fieldValue = '';
                  
                  if (prop.rich_text?.[0]?.plain_text) {
                    fieldValue = prop.rich_text[0].plain_text;
                  } else if (prop.title?.[0]?.plain_text) {
                    fieldValue = prop.title[0].plain_text;
                  } else if (prop.formula?.string) {
                    fieldValue = prop.formula.string;
                  } else if (prop.select?.name) {
                    fieldValue = prop.select.name;
                  }
                  
                  if (fieldValue && (fieldValue === driverName || fieldValue.includes(driverName))) {
                    return true;
                  }
                }
                return false;
              });
              
              if (foundDriverInBatch) {
                break;
              }
              
            } while (driverCursor && driverBatchCount < 3);
            
            driverResponse = { results: allDriverResults };
            
            const matchingDriverResults = driverResponse.results.filter((page: any) => {
              if (!('properties' in page)) return false;
              const properties = page.properties;
              
              for (const [key, value] of Object.entries(properties)) {
                const prop = value as any;
                let fieldValue = '';
                
                if (prop.rich_text?.[0]?.plain_text) {
                  fieldValue = prop.rich_text[0].plain_text;
                } else if (prop.title?.[0]?.plain_text) {
                  fieldValue = prop.title[0].plain_text;
                } else if (prop.formula?.string) {
                  fieldValue = prop.formula.string;
                } else if (prop.select?.name) {
                  fieldValue = prop.select.name;
                }
                
                if (fieldValue && (fieldValue === driverName || fieldValue.includes(driverName))) {
                  return true;
                }
              }
              
              return false;
            });
            
            if (matchingDriverResults.length > 0) {
              const driverRecord = matchingDriverResults[0] as any;
              const driverProperties = driverRecord.properties;
              
              driverDetails = {} as any;
              
              for (const [key, value] of Object.entries(driverProperties)) {
                const prop = value as any;
                let displayValue = '';
                
                switch (prop.type) {
                  case 'title':
                  case 'rich_text':
                    displayValue = prop[prop.type]?.[0]?.plain_text || '';
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
                
                if (displayValue) {
                  driverDetails[key] = displayValue;
                }
              }
              
            }
            
          } catch (driverError) {
            console.error('👤 Error fetching driver details:', driverError);
          }
          
        } catch (error) {
          console.error('👤 Error in driver details lookup:', error);
        }
      }
      
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

      // ===== Merge vouchers with the SAME driver name + SAME voucher date =====
      // All such vouchers are combined into one printout:
      //  - Expense amounts (Toll, OnRoad, Conveyance, Deduction, ECS, Amount) are
      //    summed across every voucher.
      //  - Diesel liters and Route KM's are summed only ONCE per UNIQUE diesel bill
      //    no. If two vouchers share the same bill no, the duplicate is NOT re-added.
      // Runs last so the diesel / order / driver lookups above still use the single
      // searched voucher's values.
      try {
        const baseInfo = expenseVoucherData.voucherInfo as Record<string, string>;
        const baseDriver = getVoucherDriverName(baseInfo);
        const baseDate = (baseInfo['Voucher Date :'] || '').trim();

        console.log(
          `🔎 Voucher-number merge check: driver="${baseDriver}", date="${baseDate}", vehicle="${getVoucherVehicleNumber(baseInfo)}"`
        );
        if (!baseDriver || !baseDate) {
          console.warn(
            `⚠️ Sibling merge skipped (no ${!baseDriver ? 'driver' : ''}${!baseDriver && !baseDate ? ' & ' : ''}${!baseDate ? 'date' : ''}). Available keys: ${Object.keys(baseInfo).join(' | ')}`
          );
        }

        if (baseDriver && baseDate) {
          const candidateInfos: Record<string, string>[] = [baseInfo];
          const seenIds = new Set<string>([firstMatch.id]);

          let mergeCursor: string | undefined = undefined;
          let mergeHasMore = true;
          let mergeBatches = 0;
          const MAX_MERGE_BATCHES = 10; // scan up to ~1000 recent records for siblings

          while (mergeHasMore && mergeBatches < MAX_MERGE_BATCHES) {
            const mergeResp = await queryNotionWithRetry(notion, {
              database_id: expenseVoucherDatabaseId,
              page_size: 100,
              start_cursor: mergeCursor,
              sorts: [{ timestamp: 'created_time', direction: 'descending' }]
            });
            mergeBatches++;

            const baseDriverKey = baseDriver.toLowerCase();
            for (const page of mergeResp.results as any[]) {
              if (seenIds.has(page.id)) continue;
              if (!('properties' in page)) continue;
              const info = buildVoucherInfo(page.properties);
              if (
                getVoucherDriverName(info).toLowerCase() === baseDriverKey &&
                (info['Voucher Date :'] || '').trim() === baseDate
              ) {
                seenIds.add(page.id);
                candidateInfos.push(info);
              }
            }

            mergeHasMore = mergeResp.has_more;
            mergeCursor = mergeResp.next_cursor || undefined;
          }

          if (mergeHasMore && mergeBatches >= MAX_MERGE_BATCHES) {
            console.warn(
              `⚠️ Merge scan hit batch cap (${MAX_MERGE_BATCHES}); vouchers for driver "${baseDriver}" on ${baseDate} beyond ${MAX_MERGE_BATCHES * 100} records were not merged.`
            );
          }

          console.log(
            `🚚 Voucher-number siblings (${candidateInfos.length}) vehicle values:`,
            candidateInfos.map((info) => ({
              vehicle: getVoucherVehicleNumber(info),
              voucherNo: info['Voucher No. :'] || ''
            }))
          );

          if (candidateInfos.length > 1) {
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
                `🔗 Driver "${baseDriver}" on ${baseDate}: ${vehicleGroups.length} distinct vehicles found; keeping them separate`
              );
              expenseVoucherData.voucherInfo = vehicleOptions[defaultIdx].voucherInfo;
              expenseVoucherData.mergedVoucherCount = vehicleOptions[defaultIdx].mergedVoucherCount;
              expenseVoucherData.vehicleOptions = vehicleOptions;
            } else {
              console.log(
                `🔗 Merging ${candidateInfos.length} vouchers for driver "${baseDriver}" on ${baseDate}`
              );
              expenseVoucherData.voucherInfo = mergeVoucherInfos(candidateInfos);
              expenseVoucherData.mergedVoucherCount = candidateInfos.length;
            }
          }
        }
      } catch (mergeError) {
        console.error('🔗 Error merging same driver/date vouchers:', mergeError);
        // On any merge failure, fall back to the single searched voucher's data.
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
