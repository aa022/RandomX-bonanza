// Opt-in COOP/COEP service worker (?coi=1, see NOSAB_KNOBS.md).
//
// A page served in a secure context WITHOUT the COOP/COEP headers (static
// hosts, CDNs, proxies that drop headers) is not crossOriginIsolated, so it has
// no SharedArrayBuffer and miner.js falls back to the no-SAB light workers.
// This worker re-wraps every response in its scope with the headers, so after
// one reload the page is isolated and takes the normal SAB full-mode path.
// Registered by the inline script in index.html; ?coi=0 unregisters it.
//
// Pass-through only: nothing is ever cached here, so a deploy's new
// worker.js / randomx*.wasm is never served stale.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'unregister') return;
  event.waitUntil(self.registration.unregister()
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then((clients) => Promise.all(clients.map((c) => c.navigate(c.url)))));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Chromium throws on fetch() of these (DevTools opening a resource).
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  event.respondWith(fetch(request).then((response) => {
    // Opaque (cross-origin no-cors) and opaque-redirect responses can't be
    // re-wrapped; COEP require-corp decides about them as usual.
    if (response.status === 0) return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }));
});
