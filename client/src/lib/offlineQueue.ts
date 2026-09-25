import { handleUnauthorized, queryClient } from "./queryClient";

// A durable local queue for scan submissions made while offline. Before this existed, a scan
// that couldn't reach the server just failed instantly and vanished — the page never blocked
// further scanning, so it LOOKED like scans were queuing up fine, but each one was independently
// lost the moment it happened. This module saves a scan attempt here FIRST when the network is
// unreachable, so it survives a reload/browser close, and sends everything — in the order it
// happened — the moment the connection comes back, instead of silently disappearing.
//
// IndexedDB, not localStorage: this needs to hold a couple dozen structured entries (each with
// its own retry state), and localStorage's synchronous, string-only, ~5MB-total API is the wrong
// tool for that.

const DB_NAME = "kmfinny-offline-queue";
const DB_VERSION = 1;
const STORE_NAME = "pending-requests";
const NETWORK_TIMEOUT_MS = 5000;

export type QueuedRequest = {
  localId: number; // IndexedDB auto-increment key — also the FIFO send order, since it only grows.
  url: string;
  body: Record<string, unknown>;
  clientRequestId: string;
  label: string; // shown in the pending-queue UI, e.g. "8906010500221 x 5 — Loading #123"
  createdAt: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "localId", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const req = fn(tx.objectStore(STORE_NAME));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function enqueue(entry: Omit<QueuedRequest, "localId" | "createdAt">): Promise<number> {
  return withStore("readwrite", (store) => store.add({ ...entry, createdAt: new Date().toISOString() }) as IDBRequest<number>);
}

async function listAll(): Promise<QueuedRequest[]> {
  const rows = await withStore<QueuedRequest[]>("readonly", (store) => store.getAll() as IDBRequest<QueuedRequest[]>);
  return rows.sort((a, b) => a.localId - b.localId);
}

async function remove(localId: number): Promise<void> {
  await withStore("readwrite", (store) => store.delete(localId) as unknown as IDBRequest<void>);
}

async function count(): Promise<number> {
  return withStore<number>("readonly", (store) => store.count());
}

// One id per scan ATTEMPT — resent unchanged on every retry of that same attempt (queued or
// live), so the server can recognise and skip a duplicate if this attempt actually landed
// before but its response was lost to a flaky connection.
function newClientRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type QueueState = { pending: number; flushing: boolean; lastMessage: string | null };
const listeners = new Set<(state: QueueState) => void>();
let flushing = false;
let lastMessage: string | null = null;

export function onQueueChange(listener: (state: QueueState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function notify() {
  const pending = await count();
  const state: QueueState = { pending, flushing, lastMessage };
  listeners.forEach((l) => l(state));
}

async function sendNow(url: string, body: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
}

// Sends every queued request ONE AT A TIME, in the order they were made — never in parallel, and
// never removing one until the server actually confirms it. Stops on the first sign the rest
// can't be trusted to go through cleanly (still offline, or the login session expired) instead
// of skipping ahead and sending the backlog out of order.
export async function flushQueue(): Promise<void> {
  if (flushing) return; // already running — e.g. the 'online' event and a manual "Sync now"
  // click firing close together just share the one flush already in progress.
  flushing = true;
  lastMessage = null;
  await notify();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const items = await listAll();
      if (items.length === 0) break;
      const item = items[0];

      let res: Response;
      try {
        // fromOfflineQueue tells the server this scan was physically made before the part it
        // belongs to completed — an earlier item in this same batch may have flushed first and
        // completed it, but that's just replay order, not the operator scanning something they
        // already knew was closed. Only set here, on the replay — never on the original live
        // attempt in scanOrQueue below — so a genuinely live scan on a completed part is still
        // refused as normal.
        res = await sendNow(item.url, { ...item.body, fromOfflineQueue: true });
      } catch {
        // Still offline (or the network dropped again mid-flush) — stop here, keep everything
        // queued exactly as it is, try again on the next 'online' event or manual retry.
        lastMessage = "Still offline — the rest will send once the connection is back.";
        break;
      }

      if (res.status === 401) {
        handleUnauthorized();
        // Don't discard the backlog over an expired session — stop and wait for a fresh login,
        // then flush again (the same items are still sitting here, untouched).
        lastMessage = "Your session expired — log in again to send the scans waiting to sync.";
        break;
      }

      if (!res.ok) {
        // A genuine rejection from a server we DID reach (e.g. "not enough stock") — retrying
        // this exact attempt again would just fail the same way every time. Drop only this one
        // and keep going, rather than let one bad entry block everything behind it forever.
        let message = `Failed (${res.status})`;
        try { message = (await res.json())?.message ?? message; } catch { /* non-JSON body */ }
        lastMessage = `A queued scan was rejected and removed: ${message}`;
        await remove(item.localId);
        await notify();
        continue;
      }

      await remove(item.localId);
      await notify();
      // The page(s) showing this data have no other way to find out this landed: nothing set up
      // by the ORIGINAL (offline) attempt subscribes to a response that didn't exist yet, and
      // React Query has no idea a plain fetch() just changed something server-side. Without this,
      // a flushed scan could sit invisible in per-item scan-history panels indefinitely (no poll
      // covers those), and the main item table only self-heals within its own 15s poll — easy to
      // read as "the entry never made it" when it actually did. Invalidating everything is
      // deliberately blunt: flushes are rare and small, so the refetch cost is trivial next to
      // the cost of a stale screen looking like data loss.
      queryClient.invalidateQueries();
    }
  } finally {
    flushing = false;
    await notify();
  }
}

// The one entry point every scanning page calls instead of hitting fetch/apiRequest directly.
// Tries the request live first; only falls back to the queue when the network itself is
// unreachable (a genuine fetch failure, or the browser already knows it's offline) — an HTTP
// error response (400, 409, ...) is a real rejection from a server that WAS reached, and must
// surface to the operator immediately rather than disappear into a queue.
export async function scanOrQueue(
  url: string,
  body: Record<string, unknown>,
  label: string,
): Promise<{ queued: true } | { queued: false; response: Response }> {
  const clientRequestId = newClientRequestId();
  const fullBody = { ...body, clientRequestId };

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    await enqueue({ url, body: fullBody, clientRequestId, label });
    await notify();
    return { queued: true };
  }
  try {
    const response = await sendNow(url, fullBody);
    return { queued: false, response };
  } catch {
    // fetch() itself rejected — genuinely unreachable, not a server-side rejection.
    await enqueue({ url, body: fullBody, clientRequestId, label });
    await notify();
    return { queued: true };
  }
}

export async function getQueueState(): Promise<QueueState> {
  return { pending: await count(), flushing, lastMessage };
}

export async function listQueued(): Promise<QueuedRequest[]> {
  return listAll();
}
