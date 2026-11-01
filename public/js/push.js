/* Couples App · Web Push subscription
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Platform reality:
 *  - Android Chrome: works in the browser and as an installed PWA.
 *  - iPhone: iOS 16.4+ ONLY after "Add to Home Screen", opened from the
 *    home-screen icon, and permission must be requested from a tap.
 *    In a regular Safari tab, PushManager does not exist.
 * Sending happens server-side (send-push Edge Function, Phase 4) with the
 * VAPID private key stored as a Supabase secret.
 */
import { CONFIG } from './config.js';
import { store, toast } from './store.js';
import { supabase, unwrap } from './supabase.js';
import { isIOS, isStandalone } from './ui.js';

export function pushSupport() {
  if (!('serviceWorker' in navigator)) return { ok: false, reason: 'This browser has no service worker support.' };
  if (isIOS() && !isStandalone()) {
    return { ok: false, reason: 'On iPhone, add this app to your Home Screen and open it from the icon to enable notifications.' };
  }
  if (!('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, reason: 'Push notifications are not supported here (iOS needs 16.4 or newer).' };
  }
  if (CONFIG.VAPID_PUBLIC_KEY.startsWith('YOUR-')) {
    return { ok: false, reason: 'Push is not configured yet: add your VAPID public key to js/config.js.' };
  }
  return { ok: true, reason: null };
}

export const pushPermission = () => ('Notification' in window ? Notification.permission : 'unsupported');

function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function platform() {
  if (isIOS()) return 'ios';
  if (/Android/i.test(navigator.userAgent)) return 'android';
  if (/Windows|Macintosh|Linux/i.test(navigator.userAgent)) return 'desktop';
  return 'other';
}

async function saveSubscription(sub) {
  const json = sub.toJSON();
  unwrap(await supabase.from('push_subscriptions').upsert({
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent.slice(0, 300),
    platform: platform(),
    failed_count: 0
  }, { onConflict: 'endpoint' }));
}

/** Must be called from a user gesture (required on iOS). */
export async function enablePush() {
  const support = pushSupport();
  if (!support.ok) throw new Error(support.reason);

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed. You can change this in system settings.');

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = urlB64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY);

  // If the server key changed, the old subscription is useless.
  if (sub && sub.options?.applicationServerKey) {
    const current = new Uint8Array(sub.options.applicationServerKey);
    if (current.length !== key.length || current.some((b, i) => b !== key[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await saveSubscription(sub);
  store.set({ boot: { push: 'granted' } });
  return true;
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
  store.set({ boot: { push: 'default' } });
}

/** On boot: refresh our stored subscription silently if permission is already granted. */
export async function syncPushSubscription() {
  if (!pushSupport().ok || pushPermission() !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await saveSubscription(sub);
    else await enablePush();
  } catch (err) {
    console.warn('[push] sync failed', err);
  }
}

export function listenToServiceWorker(navigate) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'NAVIGATE' && msg.url) navigate(new URL(msg.url).hash || '#/spark');
    if (msg.type === 'PUSH_SUBSCRIPTION_CHANGED') syncPushSubscription();
    if (msg.type === 'PUSH_RECEIVED' && !document.hidden) {
      toast(msg.payload?.title || 'New activity', { tone: 'love' });
    }
  });
}
