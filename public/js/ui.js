/* Couples App · DOM + feedback helpers
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 */
import { store } from './store.js';

/**
 * Hyperscript element builder. Children that are strings become text nodes,
 * so user-supplied content (display names, statuses) can never inject HTML.
 *   h('button.btn.primary', { onclick, type: 'button' }, 'Save')
 */
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = {};
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;            // only for trusted, static markup
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Trusted inline SVG icon set (static strings only). */
const ICONS = {
  spark: '<path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3.3 5 6.8 5c2 0 3.6 1.1 5.2 3 1.6-1.9 3.2-3 5.2-3 3.5 0 5.6 3.6 4.3 6.8C19.5 16.4 12 21 12 21z"/>',
  vault: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="12" cy="12" r="3.2"/><path d="M12 8.8V7M12 17v-1.8M15.2 12H17M7 12h1.8"/>',
  money: '<rect x="2.5" y="6" width="19" height="12.5" rx="3"/><circle cx="12" cy="12.25" r="2.8"/><path d="M6 9.5v5.5M18 9.5v5.5"/>',
  wishlist: '<path d="M4 10h16v10H4z"/><path d="M2.5 6.5h19V10h-19zM12 6.5V20M12 6.5C10 3 6.5 3.4 6.8 5.4 7.1 7 12 6.5 12 6.5zm0 0c2-3.5 5.5-3.1 5.2-1.1C16.9 7 12 6.5 12 6.5z"/>',
  discover: '<circle cx="12" cy="12" r="9"/><path d="M15.8 8.2l-2.2 5.4-5.4 2.2 2.2-5.4z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  face: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 15.5c1.4 1.2 3.6 1.2 5 0"/>',
  finger: '<path d="M12 11v3.5c0 2-.5 4-1.6 5.6M8.5 9.6A4 4 0 0 1 16 11v2.5c0 1.9-.3 3.7-1 5.4M5.6 15.5c.3-1.4.4-2.9.4-4.5a6 6 0 0 1 9.6-4.8M18 9.4c.2.5.3 1 .3 1.6v1.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9.5" r="1.8"/><path d="M21 15.5l-5-5-9 9.5"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>'
};

export function icon(name, { size = 24, stroke = 1.7, cls = '' } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', stroke);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

// ---- Haptics ----------------------------------------------------------------
// Android: Vibration API.
// iOS Safari has no Vibration API. Safari 18+ fires a system haptic when an
// <input type="checkbox" switch> is toggled through its <label>; we use that
// as a best-effort tick. On older iOS this is a silent no-op, and the visual
// press animation still provides feedback.
let iosHapticLabel = null;
function iosHaptic() {
  if (!iosHapticLabel) {
    const id = 'haptic-switch';
    const input = h('input', { type: 'checkbox', switch: true, id, tabindex: '-1', 'aria-hidden': 'true' });
    iosHapticLabel = h('label', { for: id, class: 'sr-haptic', 'aria-hidden': 'true' }, input);
    document.body.append(iosHapticLabel);
  }
  iosHapticLabel.click();
}

export const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function haptic(pattern = 8) {
  if (!store.get().prefs.haptics) return;
  try {
    if ('vibrate' in navigator && !isIOS()) navigator.vibrate(pattern);
    else if (isIOS()) iosHaptic();
  } catch { /* never let feedback break a tap */ }
}

/** Adds spring "press" feedback + haptic to any element. */
export function pressable(el, { haptics = true } = {}) {
  const down = () => {
    el.classList.add('is-pressed');
    if (haptics) haptic(6);
  };
  const up = () => el.classList.remove('is-pressed');
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('pointercancel', up);
  return el;
}

// ---- Time helpers -------------------------------------------------------------
export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
