// Service Worker for KM Finny - Enhanced for Android Compatibility
const CACHE_NAME = 'km-finny-v5'; // Update cache version with every significant change
const DATA_CACHE_NAME = 'km-finny-data-v5'; // Separate cache for API data
const APP_SHELL_CACHE_NAME = 'km-finny-shell-v5'; // Cache for application shell

// Core application shell files to cache for offline functionality
const APP_SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/assets/icon-512-maskable.png',
  '/assets/finny-logo.png'
];

// Dynamically cache these file types when they're used
const CACHE_EXTENSIONS = [
  '.js',
  '.css',
  '.woff2',
  '.woff',
  '.ttf',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.ico'
];

// Routes that should return index.html (SPA paths)
const SPA_ROUTES = [
  '/',
  '/login',
  '/scan',
  '/inventory',
  '/purchases',
  '/loading-operations',
  '/sales',
  '/proforma-slips',
  '/reports',
  '/users',
  '/settings',
  '/backup',
  '/scan-history',
  '/profile',
  '/messages',
  '/inout',
  '/checkinout-admin',
];

// Check if a request should be cached based on type
function shouldCacheFile(url) {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    
    // Don't cache API requests
    if (pathname.startsWith('/api/')) {
      return false;
    }
    
    // Cache specific file types
    return CACHE_EXTENSIONS.some(ext => pathname.endsWith(ext));
  } catch (e) {
    console.error('URL parsing error:', e);
    return false;
  }
}

// Check if a URL is a SPA route
function isSpaRoute(url) {
  try {
    const parsedUrl = new URL(url);
    return SPA_ROUTES.includes(parsedUrl.pathname);
  } catch (e) {
    return false;
  }
}

// Install event - cache the application shell
self.addEventListener('install', event => {
  console.log('[Service Worker] Installing');
  
  // Use waitUntil to ensure installation is not complete until caches are ready
  event.waitUntil(
    Promise.all([
      // Cache app shell
      caches.open(APP_SHELL_CACHE_NAME).then(cache => {
        console.log('[Service Worker] Caching app shell');
        return cache.addAll(APP_SHELL_FILES);
      }),
      
      // Create data cache (will be populated on fetch)
      caches.open(DATA_CACHE_NAME)
    ])
    .then(() => {
      console.log('[Service Worker] Install complete');
      return self.skipWaiting(); // Take control immediately
    })
    .catch(error => {
      console.error('[Service Worker] Install failed:', error);
    })
  );
});

// Fetch event - handle requests with appropriate caching strategies
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  
  // Don't intercept requests to other origins
  if (url.origin !== self.location.origin) {
    return;
  }
  
  // Handle API requests with a network-first approach
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (!response || response.status !== 200) {
            return response;
          }
          
          // Cache a copy of the API response for offline use
          const responseToCache = response.clone();
          caches.open(DATA_CACHE_NAME)
            .then(cache => {
              cache.put(request, responseToCache);
            })
            .catch(err => console.error('[Service Worker] API caching error:', err));
          
          return response;
        })
        .catch(() => {
          // When network fails, try to return the cached response
          return caches.match(request);
        })
    );
    return;
  }
  
  // Special handling for SPA routes - return index.html for client-side routing
  if (request.mode === 'navigate' || isSpaRoute(request.url)) {
    event.respondWith(
      fetch(request)
        .catch(() => {
          // If network fails for SPA routes, serve the cached index.html
          return caches.match('/index.html');
        })
    );
    return;
  }
  
  // For everything else, try the cache first, then network
  event.respondWith(
    caches.match(request)
      .then(cachedResponse => {
        if (cachedResponse) {
          // If found in cache, return the cached version
          return cachedResponse;
        }
        
        // If not in cache, fetch from network
        return fetch(request)
          .then(response => {
            // Check if we received a valid response
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            
            // If it's a file we should cache, add it to the cache
            if (shouldCacheFile(request.url)) {
              const responseToCache = response.clone();
              caches.open(APP_SHELL_CACHE_NAME)
                .then(cache => {
                  cache.put(request, responseToCache);
                })
                .catch(err => console.error('[Service Worker] Resource caching error:', err));
            }
            
            return response;
          })
          .catch(error => {
            console.error('[Service Worker] Fetch failed:', error);
            
            // For JavaScript or CSS files, return index.html as fallback
            if (request.url.match(/\.(js|css)$/)) {
              return caches.match('/index.html');
            }
            
            // For other resources, return a network error
            return new Response('Network error occurred', {
              status: 408,
              headers: { 'Content-Type': 'text/plain' }
            });
          });
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('[Service Worker] Activating');
  
  // Delete old versions of caches
  event.waitUntil(
    Promise.all([
      // Clean app shell cache
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.filter(cacheName => {
            return cacheName.startsWith('km-finny-') && 
                  ![CACHE_NAME, DATA_CACHE_NAME, APP_SHELL_CACHE_NAME].includes(cacheName);
          }).map(cacheName => {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          })
        );
      }),
      
      // Take control of all clients as soon as it activates
      self.clients.claim()
    ])
    .then(() => {
      console.log('[Service Worker] Activation complete');
    })
    .catch(error => {
      console.error('[Service Worker] Activation failed:', error);
    })
  );
});

// Listen for messages from the client
self.addEventListener('message', event => {
  // Handle message to clear caches
  if (event.data && event.data.action === 'clearCaches') {
    event.waitUntil(
      Promise.all([
        caches.delete(DATA_CACHE_NAME),
        caches.delete(APP_SHELL_CACHE_NAME)
      ]).then(() => {
        console.log('[Service Worker] Caches cleared');
        // Send a message back to the client
        if (event.source && event.source.postMessage) {
          event.source.postMessage({ action: 'cachesCleared' });
        }
      })
    );
  }
  
  // Handle message to skip waiting
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});