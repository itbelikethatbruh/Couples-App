/* Couples App · hash router + bottom dock
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Views are lazy ES modules exporting mount(el, ctx) → optional cleanup fn.
 * Tab changes slide with a 3D depth transition; the dock's liquid indicator
 * springs between items.
 */
import { store } from './store.js';
import { h, icon, pressable, haptic, clear } from './ui.js';

export const TABS = [
  { id: 'spark',    label: 'Spark',    icon: 'spark',    load: () => import('./views/spark.js') },
  { id: 'vault',    label: 'Vault',    icon: 'vault',    load: () => import('./views/placeholder.js') },
  { id: 'money',    label: 'Money',    icon: 'money',    load: () => import('./views/placeholder.js') },
  { id: 'wishlist', label: 'Wishlist', icon: 'wishlist', load: () => import('./views/placeholder.js') },
  { id: 'discover', label: 'Discover', icon: 'discover', load: () => import('./views/placeholder.js') }
];
const TAB_IDS = TABS.map((t) => t.id);

let viewHost = null;
let cleanup = null;
let mountToken = 0;

export function navigate(hash) {
  if (location.hash !== hash) location.hash = hash;
  else route();
}

function parse() {
  const id = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'spark').toLowerCase();
  return TAB_IDS.includes(id) ? id : 'spark';
}

async function route() {
  const id = parse();
  const prev = store.get().ui.tab;
  store.set({ ui: { tab: id } });
  await mountView(id, TAB_IDS.indexOf(id) - TAB_IDS.indexOf(prev));
}

async function mountView(id, direction) {
  const token = ++mountToken;
  const tab = TABS.find((t) => t.id === id);
  const mod = await tab.load();
  if (token !== mountToken) return;           // user tapped again while loading

  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;

  const page = h('div.page', { 'data-tab': id });
  page.classList.add(direction > 0 ? 'enter-right' : direction < 0 ? 'enter-left' : 'enter-fade');
  const old = viewHost.firstElementChild;
  if (old) {
    old.classList.add(direction > 0 ? 'leave-left' : direction < 0 ? 'leave-right' : 'leave-fade');
    old.addEventListener('animationend', () => old.remove(), { once: true });
    setTimeout(() => old.remove(), 600);
  }
  viewHost.append(page);
  viewHost.scrollTo?.({ top: 0 });
  cleanup = mod.mount(page, { tab }) || null;
}

export function initRouter(host, dockHost) {
  viewHost = host;
  renderDock(dockHost);
  window.addEventListener('hashchange', route);
  route();
}

function renderDock(dockHost) {
  clear(dockHost);
  const indicator = h('span.dock-indicator', { 'aria-hidden': 'true' });
  const items = TABS.map((t) => {
    const btn = h('a.dock-item', { href: `#/${t.id}`, 'aria-label': t.label, 'data-tab': t.id },
      h('span.dock-icon', icon(t.icon, { size: 23 })),
      h('span.dock-label', t.label));
    btn.addEventListener('click', () => haptic(8));
    return pressable(btn, { haptics: false });
  });
  const nav = h('nav.dock.glass', { 'aria-label': 'Main' }, indicator, items);
  dockHost.append(nav);

  const place = (id) => {
    const i = Math.max(0, TAB_IDS.indexOf(id));
    nav.style.setProperty('--dock-index', i);
    items.forEach((el, n) => {
      el.classList.toggle('active', n === i);
      if (n === i) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
  };
  store.select((s) => s.ui.tab, place);
}
