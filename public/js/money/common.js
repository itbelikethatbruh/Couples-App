/* Couples App · Money shared helpers
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 */
import { onTable, onResync } from '../realtime.js';
import { supabase } from '../supabase.js';
import { localDate } from '../spark/common.js';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** 12345 → "$123.45". whole: drop cents for big headline numbers. */
export function fmt(cents, { whole = false } = {}) {
  const n = (Number(cents) || 0) / 100;
  return (whole && Math.abs(n) >= 100 ? usdWhole : usd).format(n);
}

/** "$1,234.5" / "1234.50" / "12" → cents (integer), or null when not a positive amount. */
export function parseCents(input) {
  const s = String(input ?? '').replace(/[^0-9.]/g, '');
  if (!s || (s.match(/\./g) || []).length > 1) return null;
  const cents = Math.round(Number(s) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

/** Cents → "12.34" for an <input>. */
export const centsToInput = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));

export function monthRange(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return { start: localDate(start), end: localDate(end), label: start.toLocaleDateString([], { month: 'long', year: 'numeric' }) };
}

export function daysUntil(dateStr) {
  const today = new Date(`${localDate()}T00:00:00`);
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.round((d - today) / 86_400_000);
}

/** Human due label + tone for a YYYY-MM-DD date. */
export function dueLabel(dateStr) {
  const n = daysUntil(dateStr);
  if (n < 0) return { text: n === -1 ? 'Overdue · yesterday' : `Overdue · ${-n} days`, tone: 'late' };
  if (n === 0) return { text: 'Due today', tone: 'today' };
  if (n === 1) return { text: 'Due tomorrow', tone: 'soon' };
  if (n <= 7) return { text: `Due in ${n} days`, tone: 'soon' };
  return { text: `Due ${new Date(`${dateStr}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}`, tone: 'later' };
}

export const BUCKETS = {
  needs:   { label: 'Needs',   emoji: '🏠', color: '#5b5bff' },
  wants:   { label: 'Wants',   emoji: '✨', color: '#ff2d78' },
  savings: { label: 'Savings', emoji: '🌱', color: '#3ee6a8' }
};

export const CATEGORIES = [
  ['groceries', '🛒 Groceries', 'needs'], ['dining', '🍽️ Dining out', 'wants'], ['household', '🧺 Household', 'needs'],
  ['transport', '🚇 Transport', 'needs'], ['gas', '⛽ Gas', 'needs'], ['utilities', '💡 Utilities', 'needs'],
  ['health', '💊 Health', 'needs'], ['entertainment', '🎬 Entertainment', 'wants'], ['shopping', '🛍️ Shopping', 'wants'],
  ['travel', '✈️ Travel', 'wants'], ['gifts', '🎁 Gifts', 'wants'], ['pets', '🐾 Pets', 'needs'], ['kids', '🧸 Kids', 'needs'],
  ['other', '📦 Other', 'wants']
];
export const categoryLabel = (id) => CATEGORIES.find((c) => c[0] === id)?.[1] || (id ? `📦 ${id}` : '📦 Other');
export const categoryBucket = (id) => CATEGORIES.find((c) => c[0] === id)?.[2] || 'wants';

/**
 * Re-run `load` (debounced) whenever any of `tables` changes, and after a
 * reconnect. Returns an unsubscribe function.
 */
export function liveReload(tables, load, wait = 120) {
  let t = 0;
  const kick = () => { clearTimeout(t); t = setTimeout(load, wait); };
  const offs = tables.map((name) => onTable(name, kick));
  offs.push(onResync(kick));
  return () => { clearTimeout(t); offs.forEach((off) => off()); };
}

/**
 * Call an Edge Function and return its JSON, throwing the function's own
 * error message (not supabase-js's generic one) when it fails.
 */
export async function callFunction(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return data;
  let message = error.message || 'Request failed';
  try {
    const payload = await error.context?.json?.();
    if (payload?.error) message = payload.error;
  } catch { /* body was not JSON */ }
  const status = error.context?.status;
  if ((!status && /Failed to send a request|FunctionsFetchError/i.test(message)) ||
      (status === 404 && /function.*not found|not_found/i.test(message))) {
    message = 'This feature is not switched on yet (Edge Function not deployed).';
  }
  const e = new Error(message);
  e.status = error.context?.status;
  throw e;
}
