/* Couples App · realtime sync
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * One channel per couple carries three things:
 *   1. postgres_changes for every table in the public schema. Supabase checks
 *      RLS for each event, so a subscriber only receives rows it may read
 *      (blind answers and Surprise Lock claims stay hidden live, too).
 *   2. presence: who is online and which tab they are on.
 *   3. broadcast: ephemeral events that should not touch the database
 *      (live wallpaper slider preview, typing indicators, etc.).
 *
 * Feature modules register handlers with onTable()/onBroadcast() and never
 * open their own channels, which keeps us well inside free-tier limits.
 */
import { store } from './store.js';
import { supabase } from './supabase.js';

const tableHandlers = new Map();      // table → Set<fn(newRow, oldRow, eventType)>
const broadcastHandlers = new Map();  // event → Set<fn(payload)>
const resyncHandlers = new Set();

let channel = null;
let channelCoupleId = null;
let presenceTimer = 0;

export function onTable(table, fn) {
  if (!tableHandlers.has(table)) tableHandlers.set(table, new Set());
  tableHandlers.get(table).add(fn);
  return () => tableHandlers.get(table)?.delete(fn);
}

export function onBroadcast(event, fn) {
  if (!broadcastHandlers.has(event)) broadcastHandlers.set(event, new Set());
  broadcastHandlers.get(event).add(fn);
  return () => broadcastHandlers.get(event)?.delete(fn);
}

/** Called after a reconnect so modules can refetch anything they missed. */
export function onResync(fn) {
  resyncHandlers.add(fn);
  return () => resyncHandlers.delete(fn);
}

export function broadcast(event, payload) {
  if (!channel) return;
  channel.send({ type: 'broadcast', event, payload: { ...payload, from: store.get().session?.user?.id } })
    .catch(() => {});
}

export function connectRealtime(coupleId) {
  if (!supabase || !coupleId) return;
  if (channel && channelCoupleId === coupleId) return;
  disconnectRealtime();

  const myId = store.get().session.user.id;
  channelCoupleId = coupleId;
  let everJoined = false;

  channel = supabase.channel(`couple:${coupleId}`, {
    config: { presence: { key: myId }, broadcast: { self: false, ack: false } }
  });

  channel.on('postgres_changes', { event: '*', schema: 'public' }, (msg) => {
    const fns = tableHandlers.get(msg.table);
    if (!fns) return;
    for (const fn of fns) {
      try { fn(msg.new, msg.old, msg.eventType); } catch (err) { console.error('[realtime] handler', msg.table, err); }
    }
  });

  channel.on('broadcast', { event: '*' }, ({ event, payload }) => {
    if (payload?.from === myId) return;
    const fns = broadcastHandlers.get(event);
    if (!fns) return;
    for (const fn of fns) {
      try { fn(payload); } catch (err) { console.error('[realtime] broadcast', event, err); }
    }
  });

  channel.on('presence', { event: 'sync' }, () => {
    const state = channel.presenceState();
    const presence = {};
    for (const [uid, metas] of Object.entries(state)) {
      const latest = metas[metas.length - 1] || {};
      presence[uid] = { online: true, tab: latest.tab, at: latest.at };
    }
    store.replace('presence', presence);
  });

  channel.subscribe(async (status) => {
    store.set({ boot: { realtime: status } });
    if (status === 'SUBSCRIBED') {
      await trackPresence();
      if (everJoined) resyncHandlers.forEach((fn) => fn());   // reconnect: catch up
      everJoined = true;
    }
  });

  // Keep presence in sync with the current tab.
  presenceTimer = store.select((s) => s.ui.tab, () => trackPresence(), { immediate: false });

  document.addEventListener('visibilitychange', onVisibility);
}

async function trackPresence() {
  if (!channel || document.hidden) return;
  try {
    await channel.track({ tab: store.get().ui.tab, at: new Date().toISOString() });
  } catch { /* channel not ready yet */ }
}

function onVisibility() {
  if (!channel) return;
  if (document.hidden) {
    channel.untrack().catch(() => {});
  } else {
    trackPresence();
    // Mobile OSes freeze background sockets; refetch on return to be safe.
    resyncHandlers.forEach((fn) => fn());
  }
}

export function disconnectRealtime() {
  document.removeEventListener('visibilitychange', onVisibility);
  if (typeof presenceTimer === 'function') presenceTimer();
  presenceTimer = 0;
  if (channel) supabase.removeChannel(channel);
  channel = null;
  channelCoupleId = null;
  store.replace('presence', {});
}
