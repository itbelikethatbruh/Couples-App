/* Couples App · bootstrap
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Boot sequence
 *   1. Service worker, ambient 3D scene, wallpaper layers, lock host, toasts.
 *   2. No config → setup instructions.  No session → sign in.
 *   3. No couple → pair.  Couple without partner → waiting room (live).
 *   4. Paired → app shell: top bar + partner switcher, views, dock, realtime,
 *      wallpapers, auto-lock, push sync, presence heartbeat.
 */
import { isConfigured } from './config.js';
import { store, selectors, toast } from './store.js';
import { supabase } from './supabase.js';
import { h, icon, pressable, clear, haptic } from './ui.js';
import { initAmbient } from './fx.js';
import { getSession, onAuthChange, loadIdentity, renderSignIn, renderPairing, renderWaiting, onProfileRow, onCoupleRow } from './auth.js';
import { connectRealtime, onTable, onBroadcast, onResync } from './realtime.js';
import { initWallpaperEngine, loadWallpapers, onWallpaperRow, onWallpaperPreview } from './wallpaper.js';
import { initAutoLock, mountLockScreen } from './lock.js';
import { initRouter, navigate } from './router.js';
import { listenToServiceWorker, syncPushSubscription, startPushRelay } from './push.js';

const gate = document.getElementById('gate');
const app = document.getElementById('app');

// ---------------------------------------------------------------------------
// 1. Always-on infrastructure
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      // A new version finished installing: activate it on next launch.
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Update ready — reopen the app to apply', { ms: 5000 });
          }
        });
      });
    }).catch((err) => console.warn('[sw] registration failed', err));
  });
}

initAmbient();
initWallpaperEngine(document.getElementById('wallpaper'));
mountToasts(document.getElementById('toasts'));
listenToServiceWorker((hash) => navigate(hash));

// ---------------------------------------------------------------------------
// 2–4. Gatekeeping
// ---------------------------------------------------------------------------
let realtimeHandlersBound = false;
let shellMounted = false;

let booting = null;
function boot() {
  // Auth events and the initial call can overlap; run one boot at a time.
  if (!booting) booting = runBoot().finally(() => { booting = null; });
  return booting;
}

async function runBoot() {
  if (!isConfigured()) { renderSetup(); return; }

  const session = await getSession();
  if (!session) { showGate(); renderSignIn(gate); return; }

  try {
    await loadIdentity();
  } catch (err) {
    showGate();
    clear(gate).append(h('div.center-stage', h('div.auth-card.glass',
      h('h1.title-lg', "Couldn't reach the server"),
      h('p.muted', err.message),
      retryButton())));
    return;
  }

  const { me, partner } = store.get();
  if (!me?.couple_id) { showGate(); renderPairing(gate, boot); return; }

  bindRealtimeHandlers();
  connectRealtime(me.couple_id);

  if (!partner) { showGate(); renderWaiting(gate); return; }
  enterApp();
}

function retryButton() {
  const b = pressable(h('button.btn.btn-primary', { type: 'button' }, 'Try again'));
  b.addEventListener('click', boot);
  return b;
}

function showGate() {
  gate.hidden = false;
  app.hidden = true;
  document.body.classList.add('at-gate');
}

function bindRealtimeHandlers() {
  if (realtimeHandlersBound) return;
  realtimeHandlersBound = true;

  onTable('profiles', (row, old, type) => {
    const hadPartner = Boolean(store.get().partner);
    onProfileRow(row, old, type);
    // Partner just joined while we were in the waiting room.
    if (!hadPartner && store.get().partner && !shellMounted) enterApp();
  });
  onTable('couples', onCoupleRow);
  onTable('wallpaper_settings', onWallpaperRow);
  onBroadcast('wallpaper:preview', onWallpaperPreview);
  import('./views/spark.js').then(({ onLovePing }) => onTable('love_pings', onLovePing));

  onResync(async () => {
    try {
      await loadIdentity();
      if (shellMounted) await loadWallpapers();
      if (!shellMounted && store.get().partner) enterApp();
    } catch { /* offline: next resync will catch up */ }
  });
}

async function enterApp() {
  if (shellMounted) return;
  shellMounted = true;

  gate.hidden = true;
  clear(gate);
  app.hidden = false;
  document.body.classList.remove('at-gate');

  mountTopBar(document.getElementById('topbar'));
  initRouter(document.getElementById('view'), document.getElementById('dock'));
  mountLockScreen(document.getElementById('lock'));
  initAutoLock();

  loadWallpapers().catch((err) => console.warn('[wallpaper] load failed', err));
  syncPushSubscription();
  startPushRelay();
  startHeartbeat();
  handleLaunchParams();
  requestAnimationFrame(() => document.body.classList.add('app-ready'));
}

function startHeartbeat() {
  const beat = () => {
    const me = store.get().me;
    if (!me || document.hidden) return;
    supabase.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', me.id).then(() => {}, () => {});
  };
  beat();
  setInterval(beat, 120_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
}

function handleLaunchParams() {
  const params = new URLSearchParams(location.search);
  if (params.get('action') === 'love') {
    import('./views/spark.js').then(({ sendPing }) => sendPing('love'));
  }
  if (params.get('share')) {
    const shared = params.get('url') || params.get('text') || params.get('title');
    if (shared) {
      try { sessionStorage.setItem('us.pendingShare', JSON.stringify({ title: params.get('title'), text: params.get('text'), url: params.get('url') })); } catch { /* private mode */ }
      window.dispatchEvent(new CustomEvent('us:share'));
    }
  }
  if (params.toString()) history.replaceState(null, '', location.pathname + location.hash);
}

// ---------------------------------------------------------------------------
// Top bar + partner switcher
// ---------------------------------------------------------------------------
function mountTopBar(host) {
  clear(host);

  const segMe = h('button.seg', { type: 'button', role: 'tab' });
  const segPartner = h('button.seg', { type: 'button', role: 'tab' });
  const thumb = h('span.seg-thumb', { 'aria-hidden': 'true' });
  const switcher = h('div.partner-switch.glass', { role: 'tablist', 'aria-label': 'Partner focus' }, thumb, segMe, segPartner);

  const choose = (focus) => {
    if (store.get().ui.focus === focus) return;
    haptic(8);
    store.set({ ui: { focus } });
  };
  segMe.addEventListener('click', () => choose('me'));
  segPartner.addEventListener('click', () => choose('partner'));
  pressable(segMe, { haptics: false });
  pressable(segPartner, { haptics: false });

  const online = h('span.online-dot', { 'aria-hidden': 'true' });
  const settingsBtn = pressable(h('button.icon-btn.glass', { type: 'button', 'aria-label': 'Settings' }, icon('settings', { size: 21 })));
  settingsBtn.addEventListener('click', () => import('./views/settings.js').then((m) => m.openSettings()));

  host.append(switcher, settingsBtn);

  store.select(
    (s) => ({
      me: s.me?.display_name, meE: s.me?.avatar_emoji, meC: s.me?.accent,
      p: s.partner?.display_name, pE: s.partner?.avatar_emoji, pC: s.partner?.accent,
      focus: s.ui.focus, on: selectors.partnerOnline(s)
    }),
    (v) => {
      clear(segMe).append(h('span.seg-emoji', v.meE || '✨'), h('span.seg-name', v.me || 'Me'));
      clear(segPartner).append(h('span.seg-emoji', v.pE || '💞'), h('span.seg-name', v.p || 'Partner'), online);
      online.classList.toggle('on', v.on);
      switcher.dataset.focus = v.focus;
      switcher.style.setProperty('--seg-accent', v.focus === 'me' ? v.meC : v.pC);
      segMe.setAttribute('aria-selected', String(v.focus === 'me'));
      segPartner.setAttribute('aria-selected', String(v.focus === 'partner'));
    }
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function mountToasts(host) {
  store.select((s) => s.toast, (t) => {
    if (!t) {
      host.querySelectorAll('.toast').forEach((el) => {
        el.classList.add('out');
        setTimeout(() => el.remove(), 300);
      });
      return;
    }
    host.querySelectorAll('.toast').forEach((el) => el.remove());
    host.append(h(`div.toast.glass.tone-${t.tone}`, { role: 'status' }, t.message));
  });
}

// ---------------------------------------------------------------------------
// First-run setup screen (no Supabase config yet)
// ---------------------------------------------------------------------------
function renderSetup() {
  showGate();
  clear(gate).append(h('div.center-stage', h('div.auth-card.glass',
    h('h1.title-lg', 'Almost there'),
    h('p.muted', 'Connect your Supabase project to start.'),
    h('ol.setup-steps',
      h('li', 'Run supabase/schema.sql in the Supabase SQL editor.'),
      h('li', 'Copy your Project URL and anon/publishable key into public/js/config.js.'),
      h('li', 'Deploy the public/ folder to Cloudflare Pages or Vercel.')),
    h('p.muted.small', 'Full steps are in README.md.'))));
}

onAuthChange(() => {
  // Signing in or out swaps the whole identity; a clean reload is the safest reset.
  if (shellMounted) location.reload();
  else boot();
});

boot();
