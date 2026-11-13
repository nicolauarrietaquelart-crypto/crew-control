const CACHE = 'crew-control-shell-v3';
const SHELL = ['/', '/ICON.PNG', '/manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    await Promise.allSettled(SHELL.map(path => cache.add(new Request(path, {cache:'reload'}))));
  }));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('crew-control-shell-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if(req.mode === 'navigate') {
    event.respondWith(fetch(req).then(response => {
      if(response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put('/', copy)));
      }
      return response;
    }).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }
  if(SHELL.includes(url.pathname)) {
    event.respondWith(fetch(req).then(response => {
      if(response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(req, copy)));
      }
      return response;
    }).catch(() => caches.match(req)));
  }
});