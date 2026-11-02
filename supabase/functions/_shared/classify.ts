// Couples App · rule-based inbox sorter (no AI, no keys)
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// Decides where a shared thing belongs:
//   a TikTok link          → tiktok
//   any other link         → link (board picked from the website)
//   several lines of text  → list (bullets / checkboxes / quantities parsed)
//   one line of text       → note
import { isTikTokUrl } from './tiktok.ts';

export type Classified =
  | { kind: 'tiktok'; url: string; note: string | null }
  | { kind: 'link'; url: string; board_kind: 'amazon' | 'restaurants' | 'vacations' | 'events'; note: string | null }
  | { kind: 'list'; title: string; list_kind: 'grocery' | 'todo'; items: { body: string; quantity: string | null; done: boolean }[] }
  | { kind: 'note'; body: string };

const URL_RE = /https?:\/\/[^\s<>"'）)]+/i;

const BOARD_HOSTS: [RegExp, 'restaurants' | 'vacations' | 'events'][] = [
  [/(^|\.)(yelp|opentable|resy|exploretock|doordash|ubereats|grubhub|toasttab|seamless)\.com$/i, 'restaurants'],
  [/(^|\.)(airbnb|booking|expedia|vrbo|hotels|kayak|tripadvisor|marriott|hilton|hyatt|ihg|southwest|delta|united|aa|jetblue|spirit|frontier|skyscanner)\.[a-z.]+$/i, 'vacations'],
  [/(^|\.)(ticketmaster|livenation|eventbrite|seatgeek|stubhub|axs|vividseats|dice|songkick|bandsintown|fever|universe)\.[a-z.]+$/i, 'events']
];

export function boardFor(url: URL): 'amazon' | 'restaurants' | 'vacations' | 'events' {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  // Google is split by path: /maps → restaurants, /travel → vacations.
  if (/(^|\.)google\.[a-z.]+$/.test(host)) {
    if (path.startsWith('/travel')) return 'vacations';
    if (path.startsWith('/maps')) return 'restaurants';
    return 'amazon';
  }
  if (host === 'maps.app.goo.gl' || host === 'goo.gl') return 'restaurants';
  for (const [re, board] of BOARD_HOSTS) if (re.test(host)) return board;
  return 'amazon';
}

const GROCERY = new Set(('milk eggs egg bread butter cheese yogurt chicken beef pork bacon sausage ham turkey fish salmon shrimp ' +
  'rice pasta beans flour sugar salt pepper oil cereal oats coffee tea juice soda water apples apple bananas banana ' +
  'oranges lemons limes avocado avocados tomatoes tomato potatoes onions onion garlic lettuce spinach carrots broccoli ' +
  'peppers cucumber berries strawberries grapes chips cookies snacks tortillas salsa ketchup mustard mayo sauce ' +
  'detergent soap shampoo toothpaste napkins foil wipes diapers').split(' '));

const BULLET = /^\s*(?:[-*•·▪◦‣–—]|\d{1,3}[.)]|\[[ xX✓✔]?\]|☐|☑|✅|✓|✔)\s*/;
const DONE = /^\s*(?:\[[xX✓✔]\]|☑|✅|✓|✔)/;
const QTY = /^(\d+(?:[.,]\d+)?\s*(?:x|lbs?|oz|kg|g|ct|pcs?|packs?|dozen|gal|l)?)\s+(.+)$/i;
const QTY_END = /^(.+?)\s+[x×]\s*(\d+)$/i;

function parseItem(line: string) {
  const done = DONE.test(line);
  let body = line.replace(BULLET, '').trim();
  let quantity: string | null = null;
  const lead = QTY.exec(body);
  if (lead) { quantity = lead[1].trim(); body = lead[2].trim(); }
  else {
    const tail = QTY_END.exec(body);
    if (tail) { body = tail[1].trim(); quantity = tail[2]; }
  }
  return { body: body.slice(0, 300), quantity: quantity ? quantity.slice(0, 40) : null, done };
}

export function classify(rawText: string | null | undefined, rawUrl: string | null | undefined): Classified {
  const text = (rawText ?? '').replace(/\r\n?/g, '\n').trim();
  const urlStr = (rawUrl && URL_RE.test(rawUrl) ? URL_RE.exec(rawUrl)![0] : null) ?? URL_RE.exec(text)?.[0] ?? null;

  if (urlStr) {
    const note = text.replace(urlStr, '').trim().slice(0, 500) || null;
    if (isTikTokUrl(urlStr)) return { kind: 'tiktok', url: urlStr, note };
    let board: 'amazon' | 'restaurants' | 'vacations' | 'events' = 'amazon';
    try { board = boardFor(new URL(urlStr)); } catch { /* keep default */ }
    return { kind: 'link', url: urlStr, board_kind: board, note };
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return { kind: 'note', body: (lines[0] ?? '').slice(0, 300) };

  // A first line without a bullet, followed by bulleted lines (or ending in
  // ":"), is the list's title.
  let title: string | null = null;
  const bulletCount = lines.slice(1).filter((l) => BULLET.test(l)).length;
  if (!BULLET.test(lines[0]) && (lines[0].endsWith(':') || bulletCount >= Math.ceil((lines.length - 1) / 2))) {
    title = lines.shift()!.replace(/:$/, '').trim();
  }
  const items = lines.slice(0, 200).map(parseItem).filter((i) => i.body);
  const words = items.flatMap((i) => i.body.toLowerCase().split(/[^a-z]+/));
  const groceryHits = items.filter((i) => i.body.toLowerCase().split(/[^a-z]+/).some((w) => GROCERY.has(w))).length;
  const isGrocery = items.length > 0 && groceryHits / items.length >= 0.4 && words.length > 0;
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return {
    kind: 'list',
    title: (title || (isGrocery ? 'Groceries' : `List · ${today}`)).slice(0, 80),
    list_kind: isGrocery ? 'grocery' : 'todo',
    items
  };
}
