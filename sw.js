// ─── Plantis Service Worker ───────────────────────────────────────────────────
// Handles: PWA caching, push notifications, notification clicks

const CACHE = 'plantis-v1';
const ASSETS = ['/plantis/', '/plantis/index.html'];

// ─── Install & Cache ──────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Network first, fall back to cache for navigation
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/plantis/index.html'))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// ─── Push Notifications ───────────────────────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || '🌿 Plantis';
  const options = {
    body: data.body || 'Eine Pflanze braucht Wasser.',
    icon: data.icon || '/plantis/icon-192.png',
    badge: '/plantis/icon-192.png',
    tag: data.tag || 'plantis-water',
    renotify: true,
    data: { url: data.url || '/plantis/' }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/plantis/';
  e.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
      const existing = list.find(c => c.url.includes('plantis'));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});

// ─── Scheduled Check (via periodicsync if available, else on push) ────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'plantis-daily-check') {
    e.waitUntil(checkAndNotify());
  }
});

async function checkAndNotify() {
  // Plants are stored in Firebase – this is triggered by the Cloudflare Worker
  // which sends a push with the plant names that need watering.
  // Nothing to do here beyond showing the notification (handled in 'push' above).
}
