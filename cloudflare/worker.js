// Couples App · Cloudflare Worker host
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// Serves the static app in public/ straight from this public GitHub repo,
// pinned to one commit (the COMMIT variable), so a deploy is just "point
// COMMIT at the new main". Files at a fixed commit never change, so the
// edge caches them; the browser-facing headers mirror public/_headers.
const REPO = 'https://raw.githubusercontent.com/itbelikethatbruh/Couples-App';

const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8'
};

const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https://*.supabase.co; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://cdn.jsdelivr.net; frame-src https://www.tiktok.com; worker-src 'self'; manifest-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self), publickey-credentials-get=(self), publickey-credentials-create=(self), accelerometer=(self), gyroscope=(self), payment=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cross-Origin-Opener-Policy': 'same-origin'
};

function cacheControl(path) {
  if (path === '/sw.js' || path === '/index.html' || path === '/manifest.json') return 'no-cache';
  if (path.startsWith('/js/') || path.startsWith('/css/')) return 'public, max-age=0, must-revalidate';
  if (path.startsWith('/icons/')) return 'public, max-age=604800';
  return 'public, max-age=0, must-revalidate';
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const url = new URL(request.url);
    let path = decodeURIComponent(url.pathname);
    if (path.includes('..') || !/^\/[A-Za-z0-9._\/-]*$/.test(path)) return new Response('Not found', { status: 404 });
    if (path === '/' || path.endsWith('/')) path += 'index.html';
    // App routes use #hashes; any extensionless path (like /share-target
    // before the service worker is installed) gets the app shell.
    const ext = (path.split('/').pop().split('.')[1] || '').toLowerCase();
    if (!ext) path = '/index.html';
    if (path === '/_headers') return new Response('Not found', { status: 404 });

    const commit = env.COMMIT;
    const upstream = await fetch(`${REPO}/${commit}/public${path}`, {
      cf: { cacheTtl: 60 * 60 * 24 * 30, cacheEverything: true }
    });
    if (!upstream.ok) return new Response('Not found', { status: 404, headers: SECURITY });

    const headers = new Headers(SECURITY);
    headers.set('Content-Type', path === '/manifest.json' ? 'application/manifest+json' : TYPES[ext] || 'application/octet-stream');
    headers.set('Cache-Control', cacheControl(path));
    headers.set('ETag', `"${commit.slice(0, 12)}"`);
    if (path === '/sw.js') headers.set('Service-Worker-Allowed', '/');
    if (request.headers.get('If-None-Match') === headers.get('ETag')) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: 200, headers });
  }
};
