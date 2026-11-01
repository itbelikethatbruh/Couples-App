/* Couples App · "What's for dinner?" swipe matcher
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Each partner swipes privately. When both swipe right on the same card on
 * the same day, a database trigger inserts a dinner_matches row and both
 * phones celebrate at the same moment through Realtime.
 */
import { store, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, icon, pressable, clear, haptic } from '../ui.js';
import { motionAllowed } from '../fx.js';
import { onTable, onResync } from '../realtime.js';
import { formSheet, celebrate } from '../sheet.js';
import { myId, partnerName, localDate, section, disposer } from './common.js';

const CUISINE = {
  american: ['🍔', '#ff7a45'], italian: ['🍝', '#ff4d6d'], mexican: ['🌮', '#ffb703'], asian: ['🥢', '#ef476f'],
  indian: ['🍛', '#f77f00'], southern: ['🍗', '#e76f51'], seafood: ['🦐', '#4cc9f0'], mediterranean: ['🥙', '#2ec4b6'],
  breakfast: ['🥞', '#ffd166'], bbq: ['🍖', '#d62828'], african: ['🍲', '#bc6c25'], caribbean: ['🌴', '#06d6a0'],
  restaurant: ['🍽️', '#9b5cff']
};
const look = (c) => CUISINE[c] || CUISINE.restaurant;

const seenMatches = new Set();     // celebrate each match once per session

export function mount(host) {
  const dispose = disposer();
  const body = h('div.dinner-body');
  host.append(section('dinner-card', 'What’s for dinner?', body));
  let matches = [];
  let titles = {};

  async function loadMatches() {
    try {
      matches = unwrap(await supabase.from('dinner_matches').select('*').eq('for_date', localDate()));
      matches.forEach((m) => seenMatches.add(m.id));
      const ids = matches.map((m) => m.option_id);
      if (ids.length) {
        const opts = unwrap(await supabase.from('meal_options').select('id,title,cuisine').in('id', ids));
        opts.forEach((o) => { titles[o.id] = o; });
      }
    } catch (err) { console.warn('[dinner]', err); }
    render();
  }

  function render() {
    clear(body);
    if (matches.length) {
      body.append(h('div.match-list', matches.map((m) => {
        const o = titles[m.option_id];
        return h('div.match-pill', h('span', look(o?.cuisine)[0]), h('strong', o?.title || 'Match'), h('span.muted.small', 'Tonight’s match'));
      })));
    } else {
      body.append(h('p.muted', `Swipe right on what sounds good. When you and ${partnerName()} agree, it's a match.`));
    }
    const start = pressable(h('button.btn.btn-primary', { type: 'button' }, '🍽️ Start swiping'));
    start.addEventListener('click', () => openDeck());
    const add = pressable(h('button.btn.btn-ghost', { type: 'button' }, '+ Add a meal'));
    add.addEventListener('click', addMeal);
    body.append(h('div.btn-row', start, add));
  }

  dispose(onTable('dinner_matches', async (row, _o, type) => {
    if (type !== 'INSERT' || seenMatches.has(row.id)) return;
    seenMatches.add(row.id);
    let opt = titles[row.option_id];
    if (!opt) {
      const { data } = await supabase.from('meal_options').select('id,title,cuisine').eq('id', row.option_id).maybeSingle();
      opt = data;
      if (opt) titles[opt.id] = opt;
    }
    matches = [...matches.filter((m) => m.id !== row.id), row];
    render();
    haptic([20, 50, 20, 50, 60]);
    celebrate({
      emoji: look(opt?.cuisine)[0],
      title: 'It’s a Dinner Match!',
      body: `You both want ${opt?.title || 'the same thing'} tonight.`,
      actions: [{ label: '📅 Lock it in for tonight', primary: true, onClick: () => lockIn(row, opt) }]
    });
  }));
  dispose(onResync(loadMatches));
  loadMatches();
  return dispose.run;
}

async function lockIn(match, opt) {
  const start = new Date();
  start.setHours(19, 0, 0, 0);
  if (start < new Date()) start.setTime(Date.now() + 60 * 60_000);
  const { error } = await supabase.from('calendar_events').insert({
    title: `Dinner: ${opt?.title || 'our match'}`,
    starts_at: start.toISOString(),
    source_type: 'dinner_match',
    source_id: match.id
  });
  toast(error ? error.message : 'Locked in on your calendar', { tone: error ? 'error' : 'ok' });
}

async function addMeal() {
  await formSheet('Add a meal', [
    { name: 'title', label: 'What is it?', required: true, maxlength: 120, placeholder: 'Grandma’s gumbo' },
    { name: 'kind', label: 'Where', type: 'select', options: [{ value: 'home', label: '🏠 Cook at home' }, { value: 'restaurant', label: '🍽️ Go out / order in' }] },
    { name: 'cuisine', label: 'Cuisine', type: 'select', options: Object.keys(CUISINE).map((k) => ({ value: k, label: `${CUISINE[k][0]} ${k[0].toUpperCase()}${k.slice(1)}` })) },
    { name: 'pork', label: 'Contains pork', type: 'checkbox', value: false }
  ], {
    submitLabel: 'Add to deck',
    onSubmit: async (v) => {
      unwrap(await supabase.from('meal_options').insert({ title: v.title, kind: v.kind, cuisine: v.cuisine, is_pork_free: !v.pork }));
      toast('Added to the deck', { tone: 'ok' });
    }
  });
}

// ---------------------------------------------------------------------------
// Full-screen swipe deck
// ---------------------------------------------------------------------------
async function openDeck() {
  const today = localDate();
  let cards = [];
  try {
    await supabase.rpc('sync_restaurant_meals').then(() => {}, () => {});
    const [opts, swiped] = await Promise.all([
      supabase.from('meal_options').select('*').eq('active', true).then(unwrapRes),
      supabase.from('dinner_swipes').select('option_id').eq('user_id', myId()).eq('for_date', today).then(unwrapRes)
    ]);
    const done = new Set(swiped.map((s) => s.option_id));
    const hidePork = Boolean(store.get().couple?.hide_pork);
    cards = shuffle(opts.filter((o) => !done.has(o.id) && (!hidePork || o.is_pork_free)));
  } catch (err) {
    toast(err.message, { tone: 'error' });
    return;
  }

  const stack = h('div.swipe-stack');
  const closeBtn = pressable(h('button.icon-btn.glass', { type: 'button', 'aria-label': 'Close' }, icon('close', { size: 22 })));
  const nope = pressable(h('button.swipe-action.nope', { type: 'button', 'aria-label': 'Nope' }, '✕'));
  const like = pressable(h('button.swipe-action.like', { type: 'button', 'aria-label': 'Yes please' }, '♥'));
  const counter = h('span.muted.small');
  const overlay = h('div.swipe-overlay', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Dinner swiper' },
    h('header.swipe-header', h('div', h('h2.title-lg', 'Tonight?'), counter), closeBtn),
    stack,
    h('div.swipe-actions', nope, like));
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  const close = () => { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 350); };
  closeBtn.addEventListener('click', close);
  nope.addEventListener('click', () => fling(false));
  like.addEventListener('click', () => fling(true));

  let index = 0;
  let busy = false;

  function cardEl(o, depth) {
    const [emoji, hue] = look(o.cuisine);
    const art = o.image_url
      ? h('img.swipe-img', { src: o.image_url, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' })
      : h('div.swipe-art', { 'aria-hidden': 'true' }, h('span', emoji));
    const el = h('article.swipe-card', { style: { '--hue': hue, '--depth': depth } },
      art,
      h('span.stamp.stamp-like', 'YUM'),
      h('span.stamp.stamp-nope', 'NOPE'),
      h('div.swipe-info',
        h('span.q-badge', o.kind === 'home' ? '🏠 Home' : '🍽️ Out'),
        h('h3.swipe-title', o.title),
        o.cuisine ? h('span.muted.small', o.cuisine) : null));
    return el;
  }

  function renderStack() {
    clear(stack);
    counter.textContent = cards.length - index > 0 ? `${cards.length - index} left` : '';
    if (index >= cards.length) {
      stack.append(h('div.swipe-empty',
        h('div.celebrate-emoji', '🍽️'),
        h('h3', 'That’s the whole deck'),
        h('p.muted', `If ${partnerName()} swipes right on one you liked, you'll both see the match.`)));
      nope.disabled = like.disabled = true;
      return;
    }
    const visible = cards.slice(index, index + 3);
    visible.reverse().forEach((o, i) => {
      const depth = visible.length - 1 - i;
      const el = cardEl(o, depth);
      stack.append(el);
      if (depth === 0) bindDrag(el);
    });
  }

  function bindDrag(el) {
    let sx = 0; let sy = 0; let dx = 0; let dy = 0; let dragging = false; let t0 = 0;
    el.addEventListener('pointerdown', (e) => {
      dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0; t0 = performance.now();
      el.setPointerCapture(e.pointerId);
      el.style.transition = 'none';
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      const rot = dx / 18;
      el.style.transform = `translate3d(${dx}px, ${dy * 0.4}px, 0) rotate(${rot}deg) rotateY(${dx / 30}deg)`;
      el.style.setProperty('--like', Math.max(0, Math.min(1, dx / 110)));
      el.style.setProperty('--nope', Math.max(0, Math.min(1, -dx / 110)));
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      el.style.transition = '';
      const v = Math.abs(dx) / Math.max(1, performance.now() - t0);
      if (Math.abs(dx) > 110 || v > 0.6) fling(dx > 0, el);
      else { el.style.transform = ''; el.style.setProperty('--like', 0); el.style.setProperty('--nope', 0); }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  async function fling(liked, el = stack.lastElementChild) {
    if (busy || index >= cards.length || !el) return;
    busy = true;
    const o = cards[index];
    haptic(liked ? [8, 30, 8] : 6);
    el.style.setProperty(liked ? '--like' : '--nope', 1);
    el.style.transition = motionAllowed() ? 'transform 380ms cubic-bezier(.2,.8,.2,1), opacity 380ms ease' : 'none';
    el.style.transform = `translate3d(${liked ? 140 : -140}vw, -6vh, 0) rotate(${liked ? 28 : -28}deg)`;
    el.style.opacity = '0';
    supabase.from('dinner_swipes')
      .upsert({ option_id: o.id, for_date: today, liked }, { onConflict: 'option_id,user_id,for_date' })
      .then(({ error }) => { if (error) toast(error.message, { tone: 'error' }); });
    setTimeout(() => { index++; busy = false; renderStack(); }, motionAllowed() ? 260 : 0);
  }

  renderStack();
}

function unwrapRes(res) { return unwrap(res); }
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
