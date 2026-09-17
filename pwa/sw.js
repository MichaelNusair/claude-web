/**
 * Service worker: notifications, and deliberately nothing else.
 *
 * There is no `fetch` handler here, and that absence is the most important line in
 * the file. A registered worker controls navigations until it is replaced, so a
 * worker that mishandles a request can wedge the app in a way the app cannot fix:
 * the page never finishes loading, so the code that would update the worker never
 * runs either, and the only escape is clearing site data by hand. That happened
 * once, which is why the previous version of this file existed only to unregister
 * itself. Caching still buys this app nothing — it is a live WebSocket client — so
 * nothing here touches the network on the app's behalf.
 *
 * What it is for: a browser will only deliver a push message to a service worker,
 * and only if the worker shows a notification for it. So this is the smallest
 * worker that can receive `{title, body, tag}` from turn-watcher.js and put it on
 * the lock screen.
 *
 * /chat/reset.html remains the escape hatch: it unregisters whatever is registered
 * and clears storage, for a phone that ends up in a state nobody predicted.
 */
const ICON = '/chat/pwa-icons/icon-192.png';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Left behind by the caching worker that predates all of this. A phone that
      // skipped the self-uninstalling version still has them.
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/**
 * A turn ended somewhere nobody is looking.
 *
 * The payload is the JSON that turn-watcher.js built, decrypted by the browser
 * before it gets here. `showNotification` is not optional: a `userVisibleOnly`
 * subscription that receives a push and shows nothing gets one warning and then has
 * its subscription revoked, so every path out of here shows *something*.
 */
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        // Not ours, or truncated. Show what there is rather than nothing at all.
        data = { body: (() => { try { return event.data.text(); } catch { return ''; } })() };
      }

      await self.registration.showNotification(data.title || 'Claude Code', {
        body: data.body || '',
        icon: ICON,
        // One notification per conversation. `renotify` is what makes a *new*
        // answer buzz rather than silently replacing the previous one in place.
        tag: data.tag || 'cw-turn',
        renotify: true,
        // When the turn actually ended, not when the phone happened to wake up: a
        // notification delivered late otherwise claims to be current.
        timestamp: Date.parse(data.at || '') || Date.now(),
        data: { project: data.project || null, sessionId: data.sessionId || null, at: data.at || null },
      });
    })(),
  );
});

/**
 * Tapping it dismisses it, and that is all.
 *
 * No deep link on purpose. The place a notification would want to send you is a
 * conversation inside code-server's Claude panel, and there is no URL for that —
 * opening the editor would land you in whatever was last on screen, having
 * discarded nothing and helped nobody. The notification's job is to tell you the
 * wait is over; you decide what to open.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
});

/**
 * The browser rotated the subscription.
 *
 * Chrome does this on its own — a push service key rotation, a long silence — and
 * the old endpoint stops working. Without this the phone simply goes quiet, with
 * nothing wrong anywhere and nothing in any log, so the worker re-subscribes and
 * tells the server itself rather than waiting for someone to open the app.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        let subscription = event.newSubscription;
        if (!subscription) {
          const res = await fetch('/api/push/key', { credentials: 'include' });
          if (!res.ok) return;
          const { key } = await res.json();
          subscription = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(key),
          });
        }
        await fetch('/api/push/subscribe', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription),
        });
      } catch {
        /* Nothing useful to do out here. The app re-subscribes on its next load. */
      }
    })(),
  );
});

/** base64url → bytes, which is the only form `applicationServerKey` accepts. */
function keyBytes(base64url) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
