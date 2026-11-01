/* Couples App · Spark Hub shared helpers
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 */
import { store } from '../store.js';
import { h } from '../ui.js';

export const myId = () => store.get().session?.user?.id;
export const partnerId = () => store.get().partner?.id;
export const nameOf = (uid) => {
  const { me, partner } = store.get();
  if (uid && uid === me?.id) return me.display_name || 'You';
  if (uid && uid === partner?.id) return partner.display_name || 'Partner';
  return 'Partner';
};
export const partnerName = () => store.get().partner?.display_name || 'your partner';

/** Local calendar date as YYYY-MM-DD (not UTC, so late nights count as today). */
export function localDate(d = new Date()) {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}

export function section(cls, title, ...children) {
  return h(`section.glass.card.${cls}`,
    h('div.card-sheen', { 'aria-hidden': 'true' }),
    title ? h('h2.card-title', title) : null,
    ...children);
}

/** Collect cleanup fns; call the returned function to run them all. */
export function disposer() {
  const fns = [];
  const add = (fn) => { if (typeof fn === 'function') fns.push(fn); return fn; };
  add.run = () => { while (fns.length) { try { fns.pop()(); } catch { /* ignore */ } } };
  return add;
}

export function formatCountdown(ms) {
  if (ms <= 0) return 'Today';
  const d = Math.floor(ms / 86_400_000);
  const hr = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d >= 2) return `${d} days`;
  if (d === 1) return `1 day ${hr}h`;
  return `${hr}h ${m}m`;
}
