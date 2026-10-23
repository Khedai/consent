// Offline shell for the agent desk. Client information is never cached: every
// /api/ request goes to the network, and the signing pages are always fetched
// fresh so a one-time token cannot be replayed from a cache.
const CACHE = 'khusela-consent-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/sign.html',
  '/manifest.webmanifest',
  '/css/styles.css',
  '/css/sign.css',
  '/js/core.js',
  '/js/app.js',
  '/js/signing.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isNetworkOnly(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/sign/');
}

async function networkFirst(cache, request) {
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (e) {
    const hit = await cache.match(request);
    if (hit) return hit;
    const fallback = await cache.match('/index.html');
    if (fallback) return fallback;
    throw e;
  }
}

async function cacheFirst(cache, request) {
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (isNetworkOnly(url)) return;

  const html = event.request.mode === 'navigate'
    || url.pathname.endsWith('.html')
    || url.pathname === '/';

  event.respondWith(caches.open(CACHE).then((cache) => (html
    ? networkFirst(cache, event.request)
    : cacheFirst(cache, event.request))));
});
