/* Couples App · Partner Vault (Module 2)
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * A cheat-sheet about each partner: sizes, orders, favorites, dietary
 * rules, travel preferences, plus live countdowns to the dates that matter.
 * The top-bar partner switcher picks whose vault is open. Either partner
 * can fill in either vault (that's the point: you know their ring size).
 */
import { store, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, icon, pressable, clear, haptic, timeAgo } from '../ui.js';
import { tilt } from '../fx.js';
import { onTable, onResync } from '../realtime.js';
import { formSheet, confirmDialog } from '../sheet.js';
import { nameOf, localDate, formatCountdown } from '../spark/common.js';

const CATEGORIES = [
  { id: 'sizes',     title: 'Sizes',              emoji: '📏', templates: ['Ring', 'Shoe', 'Shirt / top', 'Pants', 'Dress', 'Bra', 'Hat', 'Jacket'] },
  { id: 'food',      title: 'Go-to orders',       emoji: '☕', templates: ['Coffee order', 'Fast food order', 'Pizza order', 'Favorite snacks', 'Drink of choice', 'Comfort meal'] },
  { id: 'favorites', title: 'Favorites',          emoji: '💝', templates: ['Scent / perfume', 'Brands', 'Flowers', 'Color', 'Candy', 'Stores', 'Love language'] },
  { id: 'dietary',   title: 'Allergies & diet',   emoji: '🥗', templates: ['Allergies', 'Won’t eat', 'Dietary rules', 'Medications'] },
  { id: 'travel',    title: 'Travel',             emoji: '✈️', templates: ['Airline seat', 'Preferred airline', 'Hotel must-haves', 'Loyalty programs', 'Dream destination'] },
  { id: 'other',     title: 'Other',              emoji: '📌', templates: ['Gift ideas', 'Pet peeves', 'Hype song', 'Self-care routine'] }
];
const DATE_KINDS = {
  birthday:    { emoji: '🎂', label: 'Birthday' },
  anniversary: { emoji: '💍', label: 'Anniversary' },
  trip:        { emoji: '✈️', label: 'Trip' },
  other:       { emoji: '⭐', label: 'Other' }
};

export function mount(page) {
  const header = h('header.page-header.vault-header');
  const countdowns = h('section.glass.card.countdown-card');
  const grid = h('div.vault-grid');
  page.append(header, countdowns, grid);

  let entries = [];
  let dates = [];
  const unsubs = [];

  async function load() {
    try {
      [entries, dates] = await Promise.all([
        supabase.from('vault_entries').select('*').order('sort').order('created_at').then(unwrap),
        supabase.from('important_dates').select('*').order('starts_on').then(unwrap)
      ]);
    } catch (err) { console.warn('[vault]', err); }
    render();
  }

  const focused = () => {
    const s = store.get();
    return s.ui.focus === 'partner' && s.partner ? s.partner : s.me;
  };

  function render() {
    const p = focused();
    const isMe = p?.id === store.get().me?.id;
    clear(header).append(
      h('p.eyebrow', isMe ? 'Your vault' : 'Partner vault'),
      h('h1.title-xl', `${p?.avatar_emoji || '✨'} ${p?.display_name || ''}`),
      h('p.muted.small', 'Switch partners at the top. Tap any value to edit it.')
    );
    renderCountdowns();
    clear(grid);
    for (const cat of CATEGORIES) grid.append(categoryCard(cat, p));
  }

  // ---- countdowns ----
  function nextOccurrence(d) {
    const today = new Date(`${localDate()}T00:00:00`);
    const start = new Date(`${d.starts_on}T00:00:00`);
    if (!d.recurs_yearly) {
      const end = d.ends_on ? new Date(`${d.ends_on}T23:59:59`) : new Date(`${d.starts_on}T23:59:59`);
      return end < today ? null : { at: start, years: null, ongoing: start <= today };
    }
    let next = new Date(today.getFullYear(), start.getMonth(), start.getDate());
    if (next < today) next = new Date(today.getFullYear() + 1, start.getMonth(), start.getDate());
    return { at: next, years: next.getFullYear() - start.getFullYear(), ongoing: false };
  }

  function renderCountdowns() {
    clear(countdowns);
    const add = pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, '+ Add date'));
    add.addEventListener('click', () => editDate());
    countdowns.append(h('div.card-head', h('h2.card-title', '⏳ Countdowns'), add));

    const upcoming = dates
      .map((d) => ({ d, n: nextOccurrence(d) }))
      .filter((x) => x.n)
      .sort((a, b) => a.n.at - b.n.at);
    if (!upcoming.length) {
      countdowns.append(h('p.muted.small', 'Add birthdays, your anniversary and upcoming trips.'));
      return;
    }
    const rail = h('div.countdown-rail');
    for (const { d, n } of upcoming) {
      const k = DATE_KINDS[d.kind] || DATE_KINDS.other;
      const ms = n.at.getTime() - Date.now();
      const days = Math.max(0, Math.ceil((n.at - new Date(`${localDate()}T00:00:00`)) / 86_400_000));
      let sub = n.at.toLocaleDateString([], { month: 'short', day: 'numeric', year: n.at.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
      if (n.years && d.kind === 'birthday') sub += ` · turning ${n.years}`;
      if (n.years && d.kind === 'anniversary') sub += ` · year ${n.years}`;
      const tile = pressable(h('button.countdown' + (days <= 7 ? '.soon' : ''), { type: 'button', 'aria-label': `${d.title}, ${days} days` },
        h('span.countdown-emoji', k.emoji),
        h('strong.countdown-num', n.ongoing ? 'Now' : days === 0 ? 'Today' : String(days)),
        h('span.countdown-unit', n.ongoing || days === 0 ? '🎉' : days === 1 ? 'day' : 'days'),
        h('span.countdown-title', d.title),
        h('span.muted.small', days <= 2 && !n.ongoing ? formatCountdown(ms) : sub)));
      tile.addEventListener('click', () => editDate(d));
      rail.append(tilt(tile, { max: 10 }));
    }
    countdowns.append(rail);
  }

  async function editDate(d = null) {
    const { me, partner } = store.get();
    let removed = false;
    const del = d ? h('button.btn.btn-ghost.danger.btn-block', { type: 'button' }, 'Delete date') : null;
    del?.addEventListener('click', async () => {
      if (!(await confirmDialog('Delete this date?', d.title, { confirmLabel: 'Delete', danger: true }))) return;
      const { error } = await supabase.from('important_dates').delete().eq('id', d.id);
      if (error) toast(error.message, { tone: 'error' });
      else { removed = true; document.querySelector('.sheet-host .sheet-backdrop')?.click(); }
    });
    await formSheet(d ? 'Edit date' : 'Add a date', [
      { name: 'title', label: 'Title', required: true, maxlength: 80, value: d?.title, placeholder: 'Our anniversary' },
      { name: 'kind', label: 'Type', type: 'select', value: d?.kind || 'anniversary',
        options: Object.entries(DATE_KINDS).map(([value, k]) => ({ value, label: `${k.emoji} ${k.label}` })) },
      { name: 'starts_on', label: 'Date', type: 'date', required: true, value: d?.starts_on },
      { name: 'ends_on', label: 'End date (trips)', type: 'date', value: d?.ends_on || '' },
      { name: 'about', label: 'About', type: 'select', value: d?.about_user || '',
        options: [{ value: '', label: 'Both of us' },
          { value: me?.id, label: me?.display_name || 'Me' },
          ...(partner ? [{ value: partner.id, label: partner.display_name }] : [])] },
      { name: 'recurs', label: 'Repeats every year', type: 'checkbox', value: d ? d.recurs_yearly : true }
    ], {
      extra: del,
      onSubmit: async (v) => {
        if (removed) return;
        if (v.ends_on && v.ends_on < v.starts_on) throw new Error('End date is before the start date');
        const row = {
          title: v.title, kind: v.kind, starts_on: v.starts_on, ends_on: v.ends_on || null,
          about_user: v.about || null, recurs_yearly: v.recurs && v.kind !== 'trip'
        };
        const q = d ? supabase.from('important_dates').update(row).eq('id', d.id) : supabase.from('important_dates').insert(row);
        unwrap(await q);
        haptic(10);
      }
    });
  }

  // ---- category cards ----
  function categoryCard(cat, p) {
    const mine = entries.filter((e) => e.about_user === p?.id && e.category === cat.id);
    const list = h('div.vault-list');
    for (const e of mine) {
      const copy = h('button.icon-btn.copy-btn', { type: 'button', 'aria-label': `Copy ${e.label}` }, '⧉');
      copy.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try { await navigator.clipboard.writeText(e.value); toast('Copied'); } catch { toast('Copy not allowed here'); }
      });
      const row = h('button.vault-row', { type: 'button' },
        h('span.vault-label', e.label),
        h('span.vault-value', e.value),
        e.updated_by ? h('span.vault-meta', `${nameOf(e.updated_by)} · ${timeAgo(e.updated_at)}`) : null);
      row.addEventListener('click', () => editEntry(cat, p, e));
      list.append(h('div.vault-row-wrap', row, copy));
    }
    const used = new Set(mine.map((e) => e.label.toLowerCase()));
    const suggestions = cat.templates.filter((t) => !used.has(t.toLowerCase()));
    const chips = h('div.chip-row.vault-suggest', suggestions.map((t) => {
      const c = pressable(h('button.chip.chip-sm', { type: 'button' }, `+ ${t}`));
      c.addEventListener('click', () => editEntry(cat, p, null, t));
      return c;
    }));
    const custom = pressable(h('button.chip.chip-sm.chip-ghost', { type: 'button' }, '+ Custom'));
    custom.addEventListener('click', () => editEntry(cat, p));
    chips.append(custom);

    return tilt(h('section.glass.card.vault-card',
      h('div.card-sheen', { 'aria-hidden': 'true' }),
      h('h2.card-title', `${cat.emoji} ${cat.title}`),
      mine.length ? list : h('p.muted.small', 'Nothing yet.'),
      chips), { max: 4 });
  }

  async function editEntry(cat, p, e = null, label = '') {
    let removed = false;
    const del = e ? h('button.btn.btn-ghost.danger.btn-block', { type: 'button' }, 'Delete') : null;
    del?.addEventListener('click', async () => {
      const { error } = await supabase.from('vault_entries').delete().eq('id', e.id);
      if (error) toast(error.message, { tone: 'error' });
      else { removed = true; document.querySelector('.sheet-host .sheet-backdrop')?.click(); }
    });
    await formSheet(`${p?.display_name || ''} · ${cat.title}`, [
      { name: 'label', label: 'Label', required: true, maxlength: 60, value: e?.label || label },
      { name: 'value', label: 'Value', type: 'textarea', required: true, maxlength: 500, rows: 2, value: e?.value || '' }
    ], {
      extra: del,
      onSubmit: async (v) => {
        if (removed) return;
        const row = { label: v.label, value: v.value, updated_by: store.get().session.user.id };
        const q = e
          ? supabase.from('vault_entries').update(row).eq('id', e.id)
          : supabase.from('vault_entries').insert({ ...row, about_user: p.id, category: cat.id, sort: entries.length });
        unwrap(await q);
        haptic(8);
      }
    });
  }

  unsubs.push(store.select((s) => [s.ui.focus, s.me?.display_name, s.partner?.display_name], () => render(), { immediate: false }));
  unsubs.push(onTable('vault_entries', load));
  unsubs.push(onTable('important_dates', load));
  unsubs.push(onResync(load));
  const timer = setInterval(renderCountdowns, 30_000);

  load();
  return () => { unsubs.forEach((u) => u()); clearInterval(timer); };
}
