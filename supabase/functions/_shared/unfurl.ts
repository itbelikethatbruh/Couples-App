// Couples App · link unfurling (shared by unfurl-link and universal-inbox)
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// Turns a pasted product/restaurant/travel link into a wishlist card:
// title, photo and price from the page's Open Graph tags, JSON-LD product
// data, or Amazon's product markup. Amazon often answers bots with a
// captcha; in that case we still return the ASIN, a clean link and a title
// guessed from the URL, and the app asks the person to fill in the price.
// Refuses private, loopback and link-local addresses on every hop.
import { HttpError } from './http.ts';

export type LinkInfo = {
  url: string;
  title: string | null;
  image_url: string | null;
  price_cents: number | null;
  currency: string;
  store: string;
  asin: string | null;
  blocked: boolean;
};

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'That is not a valid link'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'Only web links are supported');
  if (u.username || u.password) throw new HttpError(400, 'Links with passwords are not supported');
  const host = u.hostname.toLowerCase();
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
  if (isIp || host === 'localhost' || !host.includes('.') ||
      /\.(local|localhost|internal|lan|home|arpa)$/.test(host)) {
    throw new HttpError(400, 'That link points to a private address');
  }
  if (u.port && !['80', '443'].includes(u.port)) throw new HttpError(400, 'Unusual ports are not supported');
  return u;
}

// True for addresses that must never be fetched: private, loopback,
// link-local, CGNAT, multicast, reserved, and IPv4-mapped IPv6 forms.
function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') ||
    v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') ||
    v6.startsWith('ff') || v6.startsWith('::ffff:') || v6.startsWith('64:ff9b:');
}

// Resolve the host and refuse it if any address is non-public, so a public
// looking name that points at an internal IP is rejected before the fetch.
async function assertResolvesPublic(host: string): Promise<void> {
  const lookups = await Promise.allSettled([
    Deno.resolveDns(host, 'A'),
    Deno.resolveDns(host, 'AAAA')
  ]);
  const addrs = lookups.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (!addrs.length) throw new HttpError(400, 'That website could not be found');
  if (addrs.some(isPrivateIp)) throw new HttpError(400, 'That link points to a private address');
}

async function fetchPage(start: URL): Promise<{ finalUrl: URL; html: string; status: number }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertResolvesPublic(url.hostname);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      url = assertPublicUrl(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) {
      await res.body?.cancel();
      return { finalUrl: url, html: '', status: res.status };
    }
    // Read at most MAX_BYTES so a huge page cannot exhaust memory.
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => {});
    const buf = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, size - off)), off); off += c.length; if (off >= size) break; }
    return { finalUrl: url, html: new TextDecoder().decode(buf), status: res.status };
  }
  throw new HttpError(400, 'Too many redirects');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function meta(html: string, ...names: string[]): string | null {
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
    const a = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${esc}["'][^>]*content=["']([^"']+)["']`, 'i').exec(html);
    const b = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']${esc}["']`, 'i').exec(html);
    const v = a?.[1] ?? b?.[1];
    if (v) return decode(v);
  }
  return null;
}

function parsePrice(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const m = String(raw).replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const cents = Math.round(Number(m[1]) * 100);
  return Number.isFinite(cents) && cents > 0 && cents < 1_000_000_000 ? cents : null;
}

// deno-lint-ignore no-explicit-any
function jsonLdProduct(html: string): any | null {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const data = JSON.parse(m[1].trim());
      // deno-lint-ignore no-explicit-any
      const nodes: any[] = (Array.isArray(data) ? data : [data]).flatMap((d) => d?.['@graph'] ?? [d]);
      const hit = nodes.find((n) => {
        const t = n?.['@type'];
        return t === 'Product' || (Array.isArray(t) && t.includes('Product'));
      });
      if (hit) return hit;
    } catch { /* malformed block: skip */ }
  }
  return null;
}

const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN|product)\/([A-Z0-9]{10})(?:[/?]|$)/i;
export const isAmazon = (host: string) => /(^|\.)amazon\.[a-z.]+$/.test(host) || host === 'a.co' || host === 'amzn.to';

function titleFromSlug(u: URL): string | null {
  const parts = u.pathname.split('/').filter(Boolean);
  const i = parts.findIndex((p) => p === 'dp' || p === 'gp');
  const slug = i > 0 ? parts[i - 1] : null;
  if (!slug || slug.length < 4) return null;
  return decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim();
}

export function storeName(host: string): string {
  const h = host.replace(/^www\.|^m\.|^smile\./, '');
  if (isAmazon(h)) return 'Amazon';
  const known: Record<string, string> = {
    'target.com': 'Target', 'walmart.com': 'Walmart', 'bestbuy.com': 'Best Buy', 'etsy.com': 'Etsy',
    'sephora.com': 'Sephora', 'ulta.com': 'Ulta', 'nike.com': 'Nike', 'apple.com': 'Apple',
    'airbnb.com': 'Airbnb', 'booking.com': 'Booking.com', 'expedia.com': 'Expedia',
    'yelp.com': 'Yelp', 'opentable.com': 'OpenTable', 'resy.com': 'Resy', 'ticketmaster.com': 'Ticketmaster'
  };
  if (known[h]) return known[h];
  const base = h.split('.').slice(-2, -1)[0] || h;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export async function unfurl(input: string): Promise<LinkInfo> {
  const start = assertPublicUrl(input);
  let finalUrl = start;
  let html = '';
  try {
    ({ finalUrl, html } = await fetchPage(start));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    html = '';                                     // timeout / network: fall back to URL-only info
  }

  const host = finalUrl.hostname.toLowerCase();
  const amazon = isAmazon(host);
  const asin = (ASIN_RE.exec(finalUrl.pathname)?.[1] ?? ASIN_RE.exec(start.pathname)?.[1]
    ?? (amazon ? /name=["']ASIN["'][^>]*value=["']([A-Z0-9]{10})["']/i.exec(html)?.[1] : null) ?? null)?.toUpperCase() ?? null;

  const product = html ? jsonLdProduct(html) : null;
  const offers = product ? (Array.isArray(product.offers) ? product.offers[0] : product.offers) : null;

  let title =
    (amazon ? (/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] ?? null) : null) ??
    meta(html, 'og:title', 'twitter:title') ??
    (product?.name ? String(product.name) : null) ??
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null);
  title = title ? decode(title.replace(/<[^>]+>/g, '')) : null;

  let image =
    (amazon ? (/data-old-hires=["']([^"']+)["']/i.exec(html)?.[1] ?? null) : null) ??
    (amazon ? (() => {
      const dyn = /data-a-dynamic-image=["']([^"']+)["']/i.exec(html)?.[1];
      if (!dyn) return null;
      try { return Object.keys(JSON.parse(decode(dyn)))[0] ?? null; } catch { return null; }
    })() : null) ??
    meta(html, 'og:image', 'og:image:secure_url', 'twitter:image') ??
    (product?.image ? String(Array.isArray(product.image) ? product.image[0] : product.image?.url ?? product.image) : null);
  if (image) {
    try { image = new URL(decode(image), finalUrl).toString(); } catch { image = null; }
    if (image && !image.startsWith('https://')) image = null;
  }

  const priceCents =
    parsePrice(meta(html, 'product:price:amount', 'og:price:amount', 'twitter:data1')) ??
    parsePrice(offers?.price ?? offers?.lowPrice) ??
    (amazon ? parsePrice(/<span class=["']a-offscreen["']>\s*[^\d<]{0,4}([\d,]+\.\d{2})\s*<\/span>/i.exec(html)?.[1]) : null);
  const currency = meta(html, 'product:price:currency', 'og:price:currency') ?? offers?.priceCurrency ?? 'USD';

  // Captcha / robot-check pages have a generic title and no product data.
  const blocked = amazon && (!html || /captcha|robot check|sorry! something went wrong/i.test(html.slice(0, 20000)) ||
    !title || /^amazon(\.[a-z.]+)?$/i.test(title));
  if (blocked) {
    title = titleFromSlug(finalUrl) ?? titleFromSlug(start);
    image = null;
  }

  const canonical = amazon && asin ? `https://${host.startsWith('www.') ? host : 'www.amazon.com'}/dp/${asin}` : finalUrl.toString();

  return {
    url: canonical,
    title: title ? title.slice(0, 300) : null,
    image_url: image,
    price_cents: blocked ? null : priceCents,
    currency: String(currency).slice(0, 3).toUpperCase(),
    store: storeName(host),
    asin,
    blocked
  };
}
