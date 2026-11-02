/* Couples App · Spark Hub (Phase 1 shell)
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Live status cards, status picker and "Send love" pings, followed by the
 * hub modules: blind daily question, voice notes, polaroid calendar, dinner
 * matcher, bounty board, coupon wallet and date roulette.
 */
import * as alertsMod from '../spark/alerts.js';
import { store, selectors, toast } from '../store.js';
import { supabase } from '../supabase.js';
import { h, icon, pressable, haptic, timeAgo, clear } from '../ui.js';
import { tilt, burst } from '../fx.js';
import * as questionMod from '../spark/question.js';
import * as voiceMod from '../spark/voice.js';
import * as memoriesMod from '../spark/memories.js';
import * as dinnerMod from '../spark/dinner.js';
import * as bountyMod from '../spark/bounty.js';
import * as couponsMod from '../spark/coupons.js';
import * as rouletteMod from '../spark/roulette.js';

export const STATUSES = [
  { kind: 'available',       emoji: '🟢', label: 'Available' },
  { kind: 'work',            emoji: '💼', label: 'At work' },
  { kind: 'gym',             emoji: '🏋️', label: 'Gym' },
  { kind: 'thinking_of_you', emoji: '💭', label: 'Thinking of you' },
  { kind: 'driving',         emoji: '🚗', label: 'Driving' },
  { kind: 'sleeping',        emoji: '😴', label: 'Sleeping' },
  { kind: 'low_battery',     emoji: '🪫', label: 'Low social battery — need cuddles & grace', alert: true },
  { kind: 'need_hype',       emoji: '📣', label: 'Rough shift — need hype', alert: true }
];
const statusMeta = (kind) => STATUSES.find((s) => s.kind === kind);

export function mount(page) {
  const header = h('header.page-header',
    h('p.eyebrow', greeting()),
    h('h1.title-xl', 'Spark'));

  const cards = h('div.partner-cards');
  const picker = renderStatusPicker();
  const loveBar = renderLoveBar();

  const modules = h('div.spark-modules');
  const alertsSlot = h('div.spark-slot');
  page.append(header, alertsSlot, cards, loveBar, picker, modules);

  // Each module owns one glass card and its own realtime handlers.
  const cleanups = [alertsMod.mount(alertsSlot)];
  const parts = [questionMod, voiceMod, memoriesMod, dinnerMod, bountyMod, couponsMod, rouletteMod];
  for (const mod of parts) {
    const slot = h('div.spark-slot');
    modules.append(slot);
    try { cleanups.push(mod.mount(slot)); } catch (err) { console.error('[spark] module failed', err); }
  }

  const unsub = store.select(
    (s) => ({ me: s.me, partner: s.partner, focus: s.ui.focus, online: selectors.partnerOnline(s), p: s.presence }),
    (v) => renderCards(cards, v)
  );
  const timer = setInterval(() => renderCards(cards, {
    me: store.get().me, partner: store.get().partner, focus: store.get().ui.focus,
    online: selectors.partnerOnline(store.get())
  }), 60_000);

  return () => { unsub(); clearInterval(timer); cleanups.forEach((fn) => typeof fn === 'function' && fn()); };
}

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Late night' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
}

function renderCards(host, { me, partner, focus, online }) {
  clear(host);
  const list = [
    { p: me, who: 'You', isMe: true },
    { p: partner, who: partner ? 'Partner' : 'Not joined yet', isMe: false, online }
  ];
  if (focus === 'partner') list.reverse();

  list.forEach(({ p, who, isMe, online: on }, i) => {
    const meta = statusMeta(p?.status_kind);
    const card = h('article.glass.card.partner-card' + (i === 0 ? '.hero' : '') + (meta?.alert ? '.alert' : ''),
      { style: { '--accent': p?.accent || '#ff2d78' } },
      h('div.card-sheen', { 'aria-hidden': 'true' }),
      h('div.partner-row',
        h('div.avatar', { 'aria-hidden': 'true' }, p?.avatar_emoji || '✨'),
        h('div.partner-id',
          h('div.partner-name', p?.display_name || '—'),
          h('div.partner-sub',
            who,
            !isMe && p ? h('span.presence' + (on ? '.on' : ''), on ? ' · online' : ` · ${timeAgo(p.last_seen_at) || 'away'}`) : null))),
      h('div.status-pill' + (meta?.alert ? '.alert' : ''),
        h('span.status-emoji', meta?.emoji || p?.mood_emoji || '·'),
        h('span', p?.status_text || meta?.label || 'No status yet')),
      p?.social_battery != null
        ? h('div.battery', { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p.social_battery, 'aria-label': 'Social battery' },
            h('div.battery-fill', { style: { width: `${p.social_battery}%` } }),
            h('span.battery-label', `Social battery ${p.social_battery}%`))
        : null,
      p?.status_updated_at ? h('div.muted.small', `Updated ${timeAgo(p.status_updated_at)}`) : null
    );
    host.append(tilt(card));
  });
}

function renderStatusPicker() {
  const wrap = h('section.glass.card',
    h('h2.card-title', 'Set your status'));
  const chips = h('div.chip-row');
  STATUSES.forEach((s) => {
    const chip = pressable(h('button.chip' + (s.alert ? '.chip-alert' : ''), { type: 'button' },
      h('span', s.emoji), h('span', s.label.split(' — ')[0])));
    chip.addEventListener('click', () => setStatus(s));
    chips.append(chip);
  });

  const slider = h('input.range', { type: 'range', min: 0, max: 100, step: 5, 'aria-label': 'Social battery' });
  const sliderLabel = h('span.muted.small');
  let t = 0;
  slider.addEventListener('input', () => {
    sliderLabel.textContent = `${slider.value}%`;
    clearTimeout(t);
    t = setTimeout(() => updateMe({ social_battery: Number(slider.value), status_updated_at: new Date().toISOString() }), 400);
  });
  store.select((s) => s.me?.social_battery, (v) => {
    if (document.activeElement !== slider) slider.value = v ?? 70;
    sliderLabel.textContent = `${slider.value}%`;
  });

  wrap.append(chips, h('div.slider-row', h('span.field-label', 'Social battery'), slider, sliderLabel));
  return wrap;
}

async function updateMe(patch) {
  const me = store.get().me;
  if (!me) return;
  store.replace('me', { ...me, ...patch });          // optimistic
  const { error } = await supabase.from('profiles').update(patch).eq('id', me.id);
  if (error) {
    store.replace('me', me);
    toast(error.message, { tone: 'error' });
  }
}

async function setStatus(s) {
  haptic(10);
  await updateMe({ status_kind: s.kind, status_text: null, mood_emoji: s.emoji, status_updated_at: new Date().toISOString() });
  // Alert statuses also ping the partner (push delivery is wired in Phase 4).
  if (s.alert) await sendPing(s.kind === 'low_battery' ? 'need_cuddles' : 'need_hype');
}

function renderLoveBar() {
  const btn = pressable(h('button.love-button', { type: 'button', 'aria-label': 'Send love' },
    h('span.love-glow', { 'aria-hidden': 'true' }),
    h('span.love-heart', icon('spark', { size: 30, stroke: 1.6 })),
    h('span.love-label', 'Send love')));
  btn.addEventListener('click', async (e) => {
    const r = btn.getBoundingClientRect();
    burst({ kind: 'love', originX: r.left + r.width / 2, originY: r.top + r.height / 2, count: 28 });
    await sendPing('love');
  });
  const think = pressable(h('button.btn.btn-glass', { type: 'button' }, '💭 Thinking of you'));
  think.addEventListener('click', () => sendPing('thinking_of_you'));
  return h('section.love-bar', btn, think);
}

let lastPing = 0;
export async function sendPing(kind, message = null) {
  if (!store.get().partner) { toast('Your partner has not joined yet'); return; }
  if (Date.now() - lastPing < 1500) return;          // tap-spam guard
  lastPing = Date.now();
  const { error } = await supabase.from('love_pings').insert({ kind, message });
  if (error) toast(error.message, { tone: 'error' });
  else toast(kind === 'love' ? 'Love sent 💗' : 'Sent', { tone: 'love' });
}

/** Realtime handler registered once by app.js. */
export function onLovePing(row, _old, eventType) {
  if (eventType !== 'INSERT') return;
  const me = store.get().session?.user?.id;
  if (!row || row.sender_id === me) return;
  const label = {
    love: 'sent you love 💗',
    thinking_of_you: 'is thinking of you 💭',
    need_cuddles: 'needs cuddles & grace 🪫',
    need_hype: 'had a rough shift — send hype 📣',
    custom: row.message || 'pinged you'
  }[row.kind] || 'pinged you';
  const name = store.get().partner?.display_name || 'Your partner';
  burst({ kind: row.kind === 'love' ? 'love' : 'calm' });
  haptic([20, 60, 20, 60, 40]);
  toast(`${name} ${label}`, { tone: 'love', ms: 4200 });
}
