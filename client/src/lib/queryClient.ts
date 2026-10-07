import { QueryClient, QueryFunction } from "@tanstack/react-query";

const authStorageKeys = ["currentUser", "km-user", "userCode", "userId"];

export function handleUnauthorized() {
  if (typeof window === "undefined") {
    return;
  }

  authStorageKeys.forEach((key) => localStorage.removeItem(key));
  queryClient.setQueryData(["/api/user"], null);
  window.dispatchEvent(new CustomEvent("auth:unauthorized"));
}

async function throwIfResNotOk(res: Response) {
  if (res.status === 401) {
    handleUnauthorized();
  }

  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  isFormData?: boolean,
  parseJson: boolean = false,
  signal?: AbortSignal
): Promise<Response | any> {
  let headers: Record<string, string> = {};
  let body: FormData | string | undefined;

  if (data) {
    if (isFormData || data instanceof FormData) {
      // FormData will set its own Content-Type
      body = data as FormData;
    } else {
      headers = { "Content-Type": "application/json" };
      body = JSON.stringify(data);
    }
  }

  // Defeat HTTP caching on GETs. In production an identical polling URL is
  // otherwise served from a cache — the browser disk cache AND any upstream
  // cache (IIS ARR / CDN) that is keyed on URL and ignores request headers.
  // Request headers alone do not bust a dumb upstream cache, so we ALSO append a
  // unique timestamp param: a URL the cache has never seen cannot be served
  // stale. This forces a fresh round-trip on every poll and WS-triggered refetch.
  let requestUrl = url;
  if (method.toUpperCase() === "GET") {
    headers["Cache-Control"] = "no-cache";
    headers["Pragma"] = "no-cache";
    requestUrl += (url.includes("?") ? "&" : "?") + "_t=" + Date.now();
  }

  const res = await fetch(requestUrl, {
    method,
    headers,
    body,
    credentials: "include",
    cache: "no-store",
    signal,
  });

  if (res.status === 401) {
    handleUnauthorized();
  }

  await throwIfResNotOk(res);

  // If parseJson is true, automatically parse the response as JSON
  if (parseJson) {
    try {
      return await res.json();
    } catch (error) {
      console.error('Error parsing JSON response:', error);
      return null;
    }
  }
  
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const [endpoint, params] = queryKey as [string, Record<string, any> | undefined];
    
    // Construct URL with query parameters if provided
    let url = endpoint;
    if (params && Object.keys(params).length > 0) {
      const queryParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          queryParams.append(key, String(value));
        }
      });
      const queryString = queryParams.toString();
      if (queryString) {
        url = `${endpoint}?${queryString}`;
      }
    }

    // Unique timestamp defeats any URL-keyed upstream cache (CDN / IIS ARR) that
    // ignores request Cache-Control headers — see apiRequest for rationale.
    url += (url.includes("?") ? "&" : "?") + "_t=" + Date.now();

    const res = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" } as Record<string, string>,
    });

    if (res.status === 401) {
      handleUnauthorized();
    }

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: 30000, // 30 seconds instead of Infinity
      retry: false,
      // React Query's default ("online") PAUSES every request while the browser reports offline: a
      // slip being opened sat on its loading spinner for ever, and nothing ran at all. "always" lets the
      // request go out; offline it fails at once (or is answered from the service worker's saved copy)
      // and the page can say so.
      networkMode: "always",
    },
    mutations: {
      retry: false,
      // Same reason — and a scan must actually RUN while offline, so that scanOrQueue
      // (lib/offlineQueue.ts) can save it on this device. A paused mutation never reached it.
      networkMode: "always",
    },
  },
});
