/* Couples App service worker
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Responsibilities
 *  1. App-shell cache so the PWA opens instantly. Data is NEVER cached:
 *     every Supabase request goes straight to the network (cloud-first app).
 *  2. Web Push: show native notifications (Android + iOS 16.4+ home-screen PWA).
 *  3. Notification taps: focus an open window and route it, or open a new one.
 *  4. Android share target: forward shared text/links into the app.
 */

const VERSION = 'v1.1.0';
const SHELL_CACHE = `shell-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/app.css',
  '/js/app.js',
  '/js/config.js',
  '/js/store.js',
  '/js/supabase.js',
  '/js/auth.js',
  '/js/realtime.js',
  '/js/lock.js',
  '/js/wallpaper.js',
  '/js/router.js',
  '/js/push.js',
  '/js/fx.js',
  '/js/ui.js',
  '/js/media.js',
  '/js/sheet.js',
  '/js/views/spark.js',
  '/js/views/vault.js',
  '/js/views/placeholder.js',
  '/js/views/settings.js',
  '/js/spark/common.js',
  '/js/spark/question.js',
  '/js/spark/voice.js',
  '/js/spark/memories.js',
  '/js/spark/dinner.js',
  '/js/spark/bounty.js',
  '/js/spark/coupons.js',
  '/js/spark/roulette.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/badge-96.png'
];

// Third-party modules we load by exact, pinned version (immutable URLs).
const CDN_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Fetch strategy
//   navigations          → network first, cached shell as fallback
//   same-origin static   → stale-while-revalidate
//   pinned CDN modules   → cache first (URLs are versioned/immutable)
//   everything else      → straight to network (Supabase, TikTok, etc.)
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Android share target → hand the payload to the app via the URL.
  if (url.origin === self.location.origin && url.pathname === '/share-target') {
    const params = new URLSearchParams();
    for (const k of ['title', 'text', 'url']) {
      const v = url.searchParams.get(k);
      if (v) params.set(k, v);
    }
    event.respondWith(Response.redirect(`/?share=1&${params.toString()}#/discover`, 303));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
  // All other cross-origin requests fall through to the network untouched.
});

async function networkFirstNavigation(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    const fresh = await fetch(event.request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put('/index.html', fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match('/index.html');
    return cached || new Response('<h1>Offline</h1><p>Reconnect to sync with your partner.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  return cached || (await network) || new Response('', { status: 504 });
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') {
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, res.clone());
  }
  return res;
}

// ---------------------------------------------------------------------------
// Web Push
// Payload contract (sent by the send-push Edge Function in Phase 4):
// {
//   "title": "Thinking of you 💭",
//   "body":  "Your partner sent love",
//   "kind":  "love" | "thinking_of_you" | "need_cuddles" | "need_hype" |
//            "tiktok" | "bill_due" | "question_answered" | "dinner_match" | "generic",
//   "url":   "/#/spark",
//   "tag":   "love-ping",        // optional: collapses repeat notifications
//   "image": "https://…",        // optional (Android only)
//   "data":  { … }               // optional, forwarded to the page
// }
// ---------------------------------------------------------------------------
const KIND_DEFAULTS = {
  love:              { title: 'Love incoming 💗',      url: '/#/spark' },
  thinking_of_you:   { title: 'Thinking of you 💭',     url: '/#/spark' },
  need_cuddles:      { title: 'Low social battery 🪫',  url: '/#/spark' },
  need_hype:         { title: 'Rough shift — send hype 📣', url: '/#/spark' },
  tiktok:            { title: 'New TikTok shared 🎬',   url: '/#/discover' },
  bill_due:          { title: 'Bill due tomorrow 🧾',   url: '/#/money' },
  question_answered: { title: 'Daily question answered 🔓', url: '/#/spark' },
  dinner_match:      { title: "It's a dinner match! 🍽️", url: '/#/spark' },
  generic:           { title: 'Us',                     url: '/' }
};

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data ? event.data.json() : {};
    } catch {
      payload = { body: event.data ? event.data.text() : '' };
    }

    const kind = KIND_DEFAULTS[payload.kind] ? payload.kind : 'generic';
    const defaults = KIND_DEFAULTS[kind];
    const url = payload.url || defaults.url;

    // If the app is open and visible, let the page celebrate in-app instead of
    // stacking an OS notification on top of it. iOS requires every push to
    // show a notification, so we only skip it when a client is focused.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const focused = windows.find((c) => c.focused && c.visibilityState === 'visible');
    windows.forEach((c) => c.postMessage({ type: 'PUSH_RECEIVED', kind, payload }));
    if (focused && !isIOS()) return;

    await self.registration.showNotification(payload.title || defaults.title, {
      body: payload.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      image: payload.image,
      tag: payload.tag || kind,
      renotify: Boolean(payload.tag),
      timestamp: Date.now(),
      vibrate: [18, 40, 18],
      data: { url, kind, ...payload.data }
    });
  })());
});

function isIOS() {
  return /iPhone|iPad|iPod/.test(self.navigator.userAgent);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        client.postMessage({ type: 'NAVIGATE', url: target, kind: event.notification.data?.kind });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// The browser rotated or revoked the subscription. Tell any open page so it
// can re-subscribe and upsert the new endpoint into push_subscriptions.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach((c) => c.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' }));
  })());
});
