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

  // Defeat HTTP caching on GETs. In production (IIS ARR reverse proxy + mobile
  // browsers) an identical polling URL is otherwise served from the disk cache,
  // so live data appears stale until the cache expires. no-store forces a fresh
  // round-trip every poll and on every WebSocket-triggered refetch.
  if (method.toUpperCase() === "GET") {
    headers["Cache-Control"] = "no-cache";
    headers["Pragma"] = "no-cache";
  }

  const res = await fetch(url, {
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
    },
    mutations: {
      retry: false,
    },
  },
});
