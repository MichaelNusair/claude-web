/**
 * Self-uninstalling service worker.
 *
 * An earlier version registered a pass-through `fetch` handler. A registered
 * worker keeps controlling navigations until it is replaced — so a bad one can
 * wedge the app: the page never finishes loading, which means the code that
 * would update the worker never runs either. From the user's side the only
 * escape is manually clearing site data.
 *
 * Caching buys this app nothing (it is a live WebSocket client), so the worker
 * now unregisters itself and drops any caches it left behind. The app stays
 * installable — Chrome and Safari no longer require a fetch handler for that.
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      await self.registration.unregister();
      // Reload open tabs so they continue uncontrolled by any worker.
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const client of windows) client.navigate(client.url);
    })(),
  );
});
