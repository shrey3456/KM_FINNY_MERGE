// apiRequest's error path (see throwIfResNotOk in queryClient.ts) always throws a plain Error
// whose message is "STATUS: <raw response text>" — the server's actual JSON body arrives as text
// glued onto the front of the message, not as a parsed object. This pulls the server's own
// `message` field back out when the body was JSON, falling back to the raw error text otherwise
// (a network failure, or a non-JSON response).
export function parseApiErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const idx = raw.indexOf(": ");
  if (idx === -1) return raw;
  const body = raw.slice(idx + 2);
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON — the raw text (already assigned to `raw`) is the best available message.
  }
  return raw;
}

// A scan failed because the barcode is on the CSV/manifest/order but has no matching Product
// Master row — the server-side check in order-scan.ts/loading.ts/unloading.ts's own /scan
// handlers all tag this exact case with the same "PRODUCT_MASTER_MISSING:" prefix, so the three
// pages that each handle their own scan errors can recognize it and show the same distinct,
// centered popup (see ProductMasterMissingDialog) instead of the ordinary error toast. Returns
// the cleaned-up message (prefix stripped) when it matches, otherwise null.
const PRODUCT_MASTER_MISSING_PREFIX = "PRODUCT_MASTER_MISSING:";
export function matchProductMasterMissingError(error: unknown): string | null {
  const message = parseApiErrorMessage(error);
  if (!message.startsWith(PRODUCT_MASTER_MISSING_PREFIX)) return null;
  return message.slice(PRODUCT_MASTER_MISSING_PREFIX.length).trim();
}
