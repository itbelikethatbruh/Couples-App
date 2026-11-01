/* Couples App · core state engine
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * A tiny, dependency-free reactive store.
 *  - Single immutable state tree; updates are shallow-merged per top-level key.
 *  - select(selector, callback) fires only when the selected value changes
 *    (Object.is, with shallow comparison for plain objects and arrays).
 *  - Notifications are batched into one microtask, so a burst of realtime
 *    events triggers one render pass.
 *  - Keys listed in PERSIST_KEYS are mirrored to localStorage per device.
 */

const STORAGE_KEY = 'us.state.v1';
const PERSIST_KEYS = ['prefs', 'ui'];

const initialState = {
  boot: { ready: false, configured: true, error: null },
  session: null,            // Supabase auth session
  me: null,                 // my profile row
  partner: null,            // partner's profile row (null until they join)
  couple: null,             // couple row
  wallpapers: {},           // scope → wallpaper_settings row
  wallpaperUrls: {},        // storage_path → signed URL
  presence: {},             // user_id → { online, tab, at }
  lock: { locked: false, method: null, reason: 'boot' },
  ui: {
    tab: 'spark',
    focus: 'me',            // partner switcher: whose cards are in focus ('me' | 'partner')
    sheet: null             // open bottom sheet id
  },
  prefs: {
    lockEnabled: false,
    biometricEnabled: false,
    autoLockMinutes: 5,
    reduceMotion: false,
    parallax: true,
    haptics: true
  },
  toast: null
};

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const out = {};
    for (const k of PERSIST_KEYS) {
      if (parsed[k] && typeof parsed[k] === 'object') out[k] = parsed[k];
    }
    return out;
  } catch {
    return {};
  }
}

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

function createStore(init) {
  const persisted = loadPersisted();
  let state = { ...init };
  for (const k of PERSIST_KEYS) state[k] = { ...init[k], ...(persisted[k] || {}) };
  // A transient sheet should never survive a reload.
  state.ui = { ...state.ui, sheet: null };

  const listeners = new Set();
  let scheduled = false;
  let prevForFlush = state;

  function flush() {
    scheduled = false;
    const prev = prevForFlush;
    prevForFlush = state;
    for (const l of [...listeners]) {
      try { l(state, prev); } catch (err) { console.error('[store] listener failed', err); }
    }
    persist(prev);
  }

  function persist(prev) {
    if (!PERSIST_KEYS.some((k) => prev[k] !== state[k])) return;
    try {
      const out = {};
      for (const k of PERSIST_KEYS) out[k] = state[k];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch { /* private mode / quota: ignore */ }
  }

  return {
    get: () => state,

    /** set({ key: partial }) merges objects one level deep; set(fn) receives state. */
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      if (!next) return;
      let changed = false;
      const merged = { ...state };
      for (const [k, v] of Object.entries(next)) {
        const cur = state[k];
        const isPlain = v && typeof v === 'object' && !Array.isArray(v) &&
                        cur && typeof cur === 'object' && !Array.isArray(cur);
        const value = isPlain ? { ...cur, ...v } : v;
        if (!shallowEqual(cur, value)) { merged[k] = value; changed = true; }
      }
      if (!changed) return;
      state = merged;
      if (!scheduled) { scheduled = true; queueMicrotask(flush); }
    },

    /** Replace a top-level key outright (no merge). */
    replace(key, value) {
      if (Object.is(state[key], value)) return;
      state = { ...state, [key]: value };
      if (!scheduled) { scheduled = true; queueMicrotask(flush); }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Run callback(value, prevValue) whenever selector(state) changes. */
    select(selector, callback, { immediate = true } = {}) {
      let current = selector(state);
      if (immediate) callback(current, undefined);
      return this.subscribe((s) => {
        const next = selector(s);
        if (shallowEqual(next, current)) return;
        const prev = current;
        current = next;
        callback(next, prev);
      });
    }
  };
}

export const store = createStore(initialState);

// ---- Derived selectors ------------------------------------------------------
export const selectors = {
  myId: (s) => s.session?.user?.id ?? null,
  paired: (s) => Boolean(s.me?.couple_id && s.partner),
  /** Profile currently in focus via the partner switcher. */
  focused: (s) => (s.ui.focus === 'partner' && s.partner ? s.partner : s.me),
  /**
   * Effective wallpaper for a scope. A customised tab (inherit=false) uses its
   * own tint/blur, and its own photo if it has one, else the global photo.
   */
  wallpaperFor: (s, scope) => {
    const global = s.wallpapers.global || null;
    const tab = scope === 'global' ? null : s.wallpapers[scope];
    if (!tab || tab.inherit) return global;
    return { ...tab, storage_path: tab.storage_path || global?.storage_path || null };
  },
  partnerOnline: (s) => Boolean(s.partner && s.presence[s.partner.id]?.online)
};

// ---- Convenience actions ----------------------------------------------------
export function toast(message, { tone = 'info', ms = 2600 } = {}) {
  const id = Date.now() + Math.random();
  store.set({ toast: { id, message, tone } });
  setTimeout(() => {
    if (store.get().toast?.id === id) store.replace('toast', null);
  }, ms);
}

/** Replace one profile in state (used by both initial fetch and realtime). */
export function upsertProfile(row) {
  const s = store.get();
  const myId = selectors.myId(s);
  if (!row) return;
  if (row.id === myId) store.replace('me', row);
  else if (row.couple_id && row.couple_id === s.me?.couple_id) store.replace('partner', row);
}
