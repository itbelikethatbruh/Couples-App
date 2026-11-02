/* Couples App · "Turn on alerts" card
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Shown at the top of Spark until this device is signed up for alerts, so
 * nobody has to dig through Settings. On iPhone it first explains the one
 * thing Apple requires: alerts only work in the Home Screen app.
 */
import { toast } from '../store.js';
import { h, pressable, isIOS, isStandalone } from '../ui.js';
import { burst } from '../fx.js';
import { enablePush, pushSupport, pushPermission } from '../push.js';

const SNOOZE_KEY = 'us.alertsCardSnoozedUntil';

async function subscribedHere() {
  try {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return Boolean(reg && (await reg.pushManager?.getSubscription()));
  } catch { return false; }
}

function snoozed() {
  try { return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now(); } catch { return false; }
}
function snooze(days) {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + days * 86400e3)); } catch { /* private mode */ }
}

export function mount(host) {
  let alive = true;
  (async () => {
    if (snoozed()) return;
    if (pushPermission() === 'granted' && (await subscribedHere())) return;
    if (!alive) return;
    host.append(render(() => host.replaceChildren()));
  })();
  return () => { alive = false; };
}

function render(remove) {
  const later = pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, 'Later'));
  later.addEventListener('click', () => { snooze(3); remove(); });
  const card = h('section.glass.card.alerts-card',
    h('div.card-sheen', { 'aria-hidden': 'true' }),
    h('div.card-head', h('h2.card-title', '🔔 Get alerts on this phone'), later));

  const iphoneNeedsHomeScreen = isIOS() && !isStandalone();
  const support = pushSupport();

  if (iphoneNeedsHomeScreen) {
    card.append(
      h('p.small.muted', 'Apple only allows alerts from the Home Screen app, not from a Safari tab.'),
      h('ol.steps',
        h('li', 'In Safari, tap ', h('strong', 'Share'), ' (the square with the arrow).'),
        h('li', 'Tap ', h('strong', 'Add to Home Screen'), ', then ', h('strong', 'Add'), '.'),
        h('li', 'Close Safari and open ', h('strong', 'Us'), ' from the new icon.'),
        h('li', 'This card shows a ', h('strong', 'Turn on alerts'), ' button there. Tap it and choose ', h('strong', 'Allow'), '.')));
    return card;
  }

  if (pushPermission() === 'denied') {
    card.append(h('p.small.muted', isIOS()
      ? 'Alerts were turned off for Us. Open the iPhone Settings app → Notifications → Us → Allow Notifications, then come back.'
      : 'Alerts were blocked. Long-press the Us icon → App info → Notifications → turn them on, then come back.'));
    return card;
  }

  if (!support.ok) {
    card.append(h('p.small.muted', support.reason));
    return card;
  }

  const on = pressable(h('button.btn.btn-primary.btn-block', { type: 'button' }, 'Turn on alerts'));
  on.addEventListener('click', async () => {
    on.disabled = true;
    on.textContent = 'Turning on…';
    try {
      await enablePush();
      const r = on.getBoundingClientRect();
      burst({ kind: 'love', count: 26, originX: r.left + r.width / 2, originY: r.top });
      toast('Alerts on 🔔 You’ll hear about pings, TikToks, answers and more.', { tone: 'ok', ms: 3600 });
      setTimeout(remove, 500);
    } catch (err) {
      toast(err.message, { tone: 'error', ms: 4200 });
      on.disabled = false;
      on.textContent = 'Turn on alerts';
    }
  });
  card.append(
    h('p.small.muted', 'Love pings, new TikToks, answers, voice notes, dinner matches and finished tasks from your partner.'),
    on);
  return card;
}
