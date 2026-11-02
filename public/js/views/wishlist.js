/* Couples App · Smart Wishlists (Module 4)
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * A personal gift board for each partner plus shared Restaurants,
 * Vacations and Events boards (and any custom ones). Paste a link and the
 * unfurl-link Edge Function fills in the title, photo and price.
 *
 * Surprise Lock: on your partner's board you can secretly claim an item.
 * The claim lives in wishlist_claims, which Row Level Security shows only
 * to the person who made it, so your partner's phone never learns about it
 * (not in queries, not in realtime events).
 */
import { store, selectors, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic } from '../ui.js';
import { tilt, burst } from '../fx.js';
import { formSheet, confirmDialog, celebrate } from '../sheet.js';
import { nameOf, disposer } from '../spark/common.js';
import { fmt, parseCents, centsToInput, liveReload, callFunction } from '../money/common.js';

const PRIORITY = {
  must_have: { label: 'Must have', emoji: '🔥', rank: 0 },
  need_soon: { label: 'Need soon', emoji: '⏳', rank: 1 },
  treat:     { label: 'Treat',     emoji: '🍬', rank: 2 }
};
const KIND_EMOJI = { amazon: '🎁', restaurants: '🍽️', vacations: '✈️', events: '🎟️', custom: '📌' };
const URL_RE = /https?:\/\/[^\s<>"']+/i;
const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i;

export function mount(page) {
  const dispose = disposer();
  const header = h('header.page-header');
  const rail = h('div.board-rail', { role: 'tablist', 'aria-label': 'Lists' });
  const toolbar = h('div.wish-toolbar');
  const grid = h('div.wish-grid');
  page.append(header, rail, toolbar, grid);

  let boards = [];
  let items = [];
  let claims = new Map();            // item_id → my claim row
  let boardId = null;
  let filter = 'all';
  let loaded = false;

  const me = () => store.get().me;
  const board = () => boards.find((b) => b.id === boardId) || null;
  const boardName = (b) => b.owner_id
    ? `${nameOf(b.owner_id)}${b.owner_id === me()?.id ? ' (you)' : ''}`
    : b.title || 'List';
  const isPartnerBoard = (b) => Boolean(b?.owner_id && b.owner_id !== me()?.id);
  const isMyBoard = (b) => b?.owner_id === me()?.id;

  function pickDefaultBoard() {
    const focused = selectors.focused(store.get());
    return boards.find((b) => b.kind === 'amazon' && b.owner_id === focused?.id)?.id || boards[0]?.id || null;
  }

  async function load() {
    try {
      const [b, i, c] = await Promise.all([
        loaded ? supabase.from('wishlist_boards').select('*').order('sort').order('created_at').then(unwrap)
               : supabase.rpc('ensure_wishlist_boards').then(unwrap),
        supabase.from('wishlist_items').select('*').order('created_at', { ascending: false }).limit(500).then(unwrap),
        supabase.from('wishlist_claims').select('*').then(unwrap)
      ]);
      boards = b || [];
      items = i || [];
      claims = new Map((c || []).map((row) => [row.item_id, row]));
      loaded = true;
      if (!boards.some((x) => x.id === boardId)) boardId = pickDefaultBoard();
    } catch (err) {
      console.warn('[wishlist]', err);
      if (!loaded) toast(err.message, { tone: 'error' });
    }
    render();
  }

  function render() {
    const b = board();
    clear(header).append(
      h('p.eyebrow', b ? (isPartnerBoard(b) ? 'Their wishlist · Surprise Lock on' : isMyBoard(b) ? 'Your wishlist' : 'Shared list') : 'Wishlists'),
      h('h1.title-xl', b ? `${b.emoji || KIND_EMOJI[b.kind]} ${boardName(b)}` : 'Wishlists'));

    clear(rail);
    for (const x of boards) {
      const count = items.filter((i) => i.board_id === x.id && !i.owner_purchased).length;
      const chip = pressable(h('button.chip.board-chip' + (x.id === boardId ? '.active' : ''),
        { type: 'button', role: 'tab', 'aria-selected': String(x.id === boardId) },
        `${x.emoji || KIND_EMOJI[x.kind]} ${boardName(x)}`, count ? h('span.board-count', String(count)) : null));
      chip.addEventListener('click', () => { boardId = x.id; filter = 'all'; haptic(6); render(); });
      rail.append(chip);
    }
    const newBoard = pressable(h('button.chip.chip-ghost', { type: 'button' }, '+ List'));
    newBoard.addEventListener('click', createBoard);
    rail.append(newBoard);

    renderToolbar(b);
    renderGrid(b);
  }

  function boardItems(b) {
    return items
      .filter((i) => i.board_id === b?.id)
      .sort((x, y) => (Number(x.owner_purchased) - Number(y.owner_purchased))
        || (PRIORITY[x.priority].rank - PRIORITY[y.priority].rank)
        || (x.created_at < y.created_at ? 1 : -1));
  }

  function renderToolbar(b) {
    clear(toolbar);
    if (!b) return;
    const list = boardItems(b);
    const open = list.filter((i) => !i.owner_purchased);
    const value = open.reduce((s, i) => s + (Number(i.price_cents) || 0), 0);
    const add = pressable(h('button.btn.btn-primary.btn-sm', { type: 'button' }, '+ Add'));
    add.addEventListener('click', () => editItem(null, b));
    const chips = h('div.chip-row', [['all', 'All'], ...Object.entries(PRIORITY).map(([k, p]) => [k, `${p.emoji} ${p.label}`])].map(([k, label]) => {
      const c = pressable(h('button.chip.chip-sm' + (filter === k ? '.active' : ''), { type: 'button' }, label));
      c.addEventListener('click', () => { filter = k; renderToolbar(b); renderGrid(b); });
      return c;
    }));
    toolbar.append(
      h('div.wish-stats',
        h('span', `${open.length} open`),
        value ? h('span', `${fmt(value, { whole: true })} total`) : null,
        isPartnerBoard(b) ? h('span.lock-note', `🔒 ${nameOf(b.owner_id)} can’t see what you claim`) : null),
      h('div.wish-tools', chips, add));
  }

  function renderGrid(b) {
    clear(grid);
    if (!b) { grid.append(h('p.muted.small', 'Loading lists…')); return; }
    const list = boardItems(b).filter((i) => filter === 'all' || i.priority === filter);
    if (!list.length) {
      grid.append(h('div.glass.card.wish-empty',
        h('div.card-sheen', { 'aria-hidden': 'true' }),
        h('p.lead', filter !== 'all' ? 'Nothing with that tag.' : isPartnerBoard(b)
          ? `${nameOf(b.owner_id)} hasn’t added anything yet. Add ideas for them, they’ll see them.`
          : 'Paste a link from Amazon, Target, Etsy, Airbnb, a restaurant… and it fills itself in.')));
      return;
    }
    for (const item of list) grid.append(itemCard(item, b));
  }

  function itemCard(item, b) {
    const claim = claims.get(item.id);
    const p = PRIORITY[item.priority];
    const img = item.image_url
      ? h('img.wish-img', { src: item.image_url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' })
      : h('div.wish-img.placeholder', { 'aria-hidden': 'true' }, b.emoji || KIND_EMOJI[b.kind]);
    img.addEventListener?.('error', () => img.replaceWith(h('div.wish-img.placeholder', { 'aria-hidden': 'true' }, b.emoji || KIND_EMOJI[b.kind])));

    const actions = [];
    const act = (label, cls, fn) => {
      const btn = pressable(h(`button.btn.btn-sm.${cls}`, { type: 'button' }, label));
      btn.addEventListener('click', async (e) => { e.stopPropagation(); btn.disabled = true; try { await fn(btn); } finally { btn.disabled = false; } });
      actions.push(btn);
    };
    if (isPartnerBoard(b) && !item.owner_purchased) {
      if (claim) act('Unlock', 'btn-ghost', () => unclaim(item, claim));
      else act('🔒 I’ll get it', 'btn-glass', (btn) => claimItem(item, b, btn));
    } else {
      act(item.owner_purchased ? 'Undo' : b.kind === 'restaurants' || b.kind === 'events' || b.kind === 'vacations' ? 'Done ✓' : 'Got it ✓',
        'btn-ghost', () => togglePurchased(item));
    }
    if (item.url) {
      const open = h('a.btn.btn-sm.btn-ghost', { href: item.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open ${item.title}` }, '↗');
      open.addEventListener('click', (e) => e.stopPropagation());
      actions.push(open);
    }

    const card = h('article.wish-card.glass' + (item.owner_purchased ? '.purchased' : '') + (claim ? '.claimed' : ''),
      { tabindex: '0', 'aria-label': item.title },
      h('div.card-sheen', { 'aria-hidden': 'true' }),
      h('div.wish-media', img,
        h('span.prio-tag.prio-' + item.priority, `${p.emoji} ${p.label}`),
        claim ? h('div.surprise-veil', h('span.lock-3d', { 'aria-hidden': 'true' }, '🔒'), h('strong', 'You’re getting this'), h('span.small', `Only you can see this${claim.note ? ` · ${claim.note}` : ''}`)) : null,
        item.owner_purchased ? h('span.bought-stamp', b.owner_id ? 'Bought' : 'Done') : null),
      h('div.wish-info',
        h('strong.wish-title', item.title),
        h('div.wish-meta',
          item.price_cents != null ? h('span.wish-price', fmt(item.price_cents)) : null,
          item.store ? h('span.muted.small', item.store) : null),
        item.notes ? h('p.muted.small.wish-notes', item.notes) : null,
        h('div.wish-actions', actions)));
    card.addEventListener('click', () => editItem(item, b));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') editItem(item, b); });
    return tilt(card, { max: 8 });
  }

  async function claimItem(item, b, btn) {
    const v = await formSheet('Surprise Lock 🔒', [
      { name: 'note', label: 'Private note (only you see it)', maxlength: 280, placeholder: 'Ordered, arrives Friday · hide in trunk' }
    ], { submitLabel: 'Lock it in' });
    if (!v) return;
    try {
      const row = unwrap(await supabase.from('wishlist_claims').insert({ item_id: item.id, note: v.note || null }).select('*').single());
      claims.set(item.id, row);
      haptic([10, 40, 10]);
      const r = btn.getBoundingClientRect();
      burst({ kind: 'love', count: 26, originX: r.left + r.width / 2, originY: r.top });
      celebrate({ emoji: '🤫', title: 'Locked in', body: `${nameOf(b.owner_id)} still sees “${item.title}” as open. Your secret is safe.`, kind: 'love' });
      render();
    } catch (err) {
      toast(/duplicate|unique/i.test(err.message) ? 'Someone already claimed this one' : err.message, { tone: 'error' });
    }
  }

  async function unclaim(item, claim) {
    if (!(await confirmDialog('Release this item?', 'It goes back to looking open. Nobody is told.', { confirmLabel: 'Release' }))) return;
    try {
      unwrap(await supabase.from('wishlist_claims').delete().eq('id', claim.id));
      claims.delete(item.id);
      render();
    } catch (err) { toast(err.message, { tone: 'error' }); }
  }

  async function togglePurchased(item) {
    try {
      unwrap(await supabase.from('wishlist_items').update({ owner_purchased: !item.owner_purchased }).eq('id', item.id));
      item.owner_purchased = !item.owner_purchased;
      haptic(8);
      render();
    } catch (err) { toast(err.message, { tone: 'error' }); }
  }

  async function createBoard() {
    const { partner } = store.get();
    await formSheet('New list', [
      { name: 'title', label: 'Name', required: true, maxlength: 60, placeholder: 'Home decor' },
      { name: 'emoji', label: 'Emoji', maxlength: 8, value: '📌' },
      { name: 'owner', label: 'Whose list', type: 'select', value: '',
        options: [{ value: '', label: 'Shared' }, { value: me()?.id, label: 'Mine (gift ideas for me)' },
          ...(partner ? [{ value: partner.id, label: `${partner.display_name}’s (Surprise Lock on)` }] : [])] }
    ], {
      onSubmit: async (v) => {
        const row = unwrap(await supabase.from('wishlist_boards')
          .insert({ kind: 'custom', title: v.title, emoji: v.emoji || '📌', owner_id: v.owner || null, sort: 100 + boards.length })
          .select('*').single());
        boards.push(row);
        boardId = row.id;
        render();
      }
    });
  }

  async function editItem(item, b) {
    let removed = false;
    let fetched = { image_url: item?.image_url || null, store: item?.store || null, asin: item?.asin || null, currency: item?.currency || 'USD' };
    const preview = h('div.unfurl-preview', { hidden: !fetched.image_url },
      fetched.image_url ? h('img', { src: fetched.image_url, alt: '', referrerpolicy: 'no-referrer' }) : null);
    const status = h('p.muted.small.unfurl-status');
    const del = item ? h('button.btn.btn-ghost.danger.btn-block', { type: 'button' }, 'Remove from list') : null;
    del?.addEventListener('click', async () => {
      if (!(await confirmDialog('Remove this item?', item.title, { confirmLabel: 'Remove', danger: true }))) return;
      const { error } = await supabase.from('wishlist_items').delete().eq('id', item.id);
      if (error) toast(error.message, { tone: 'error' });
      else { removed = true; document.querySelector('.sheet-host .sheet-backdrop')?.click(); }
    });

    const pending = formSheet(item ? 'Edit item' : `Add to ${boardName(b)}`, [
      { name: 'url', label: 'Link', type: 'url', value: item?.url || '', placeholder: 'Paste a product, restaurant or trip link', inputmode: 'url' },
      { name: 'title', label: 'Name', required: true, maxlength: 300, value: item?.title || '' },
      { name: 'price', label: 'Price ($)', inputmode: 'decimal', value: centsToInput(item?.price_cents ?? null), placeholder: 'Optional' },
      { name: 'priority', label: 'Priority', type: 'select', value: item?.priority || 'treat',
        options: Object.entries(PRIORITY).map(([value, p]) => ({ value, label: `${p.emoji} ${p.label}` })) },
      { name: 'notes', label: 'Notes', type: 'textarea', maxlength: 1000, rows: 2, value: item?.notes || '',
        placeholder: b.kind === 'amazon' ? 'Size, color, model…' : 'Why you want to go, best time, who recommended it…' }
    ], {
      submitLabel: item ? 'Save' : 'Add',
      extra: h('div', status, preview, del),
      onSubmit: async (v) => {
        if (removed) return;
        let url = v.url ? (URL_RE.exec(v.url)?.[0] || '') : '';
        if (v.url && !url) throw new Error('That link doesn’t look right');
        const price = v.price === '' ? null : parseCents(v.price);
        if (v.price !== '' && price == null) throw new Error('Check the price');
        const asin = fetched.asin || ASIN_RE.exec(url)?.[1]?.toUpperCase() || null;
        if (asin && /amazon\./i.test(url)) url = `https://www.amazon.com/dp/${asin}`;
        const row = {
          url: url || null, title: v.title, price_cents: price, priority: v.priority, notes: v.notes || null,
          image_url: fetched.image_url, store: fetched.store || (url ? new URL(url).hostname.replace(/^www\./, '') : null),
          asin, currency: fetched.currency || 'USD'
        };
        if (item) unwrap(await supabase.from('wishlist_items').update(row).eq('id', item.id));
        else unwrap(await supabase.from('wishlist_items').insert({ ...row, board_id: b.id }));
        if (b.kind === 'restaurants') supabase.rpc('sync_restaurant_meals').then(() => {}, () => {});
        haptic(10);
      }
    });

    // Auto-fill from the link as soon as one is pasted.
    const form = [...document.querySelectorAll('.sheet-host')].pop()?.querySelector('form');
    const urlInput = form?.querySelector('[name=url]');
    const titleInput = form?.querySelector('[name=title]');
    const priceInput = form?.querySelector('[name=price]');
    let lastFetched = item?.url || '';
    let seq = 0;
    const unfurl = async () => {
      const url = URL_RE.exec(urlInput.value)?.[0];
      if (!url || url === lastFetched) return;
      if (urlInput.value !== url) urlInput.value = url;       // shared text often wraps the link in a sentence
      lastFetched = url;
      const mine = ++seq;
      status.textContent = 'Fetching details…';
      try {
        const info = await callFunction('unfurl-link', { url });
        if (mine !== seq) return;
        fetched = { image_url: info.image_url, store: info.store, asin: info.asin, currency: info.currency };
        if (info.url) { urlInput.value = info.url; lastFetched = info.url; }
        if (info.title && !titleInput.value.trim()) titleInput.value = info.title;
        if (info.price_cents && !priceInput.value.trim()) priceInput.value = centsToInput(info.price_cents);
        clear(preview);
        if (info.image_url) { preview.append(h('img', { src: info.image_url, alt: '', referrerpolicy: 'no-referrer' })); preview.hidden = false; }
        status.textContent = info.blocked
          ? `${info.store} hid the details from our robot. Name and price are up to you.`
          : `Filled in from ${info.store}${info.price_cents ? '' : ' (no price found)'}`;
      } catch (err) {
        if (mine !== seq) return;
        const asin = ASIN_RE.exec(url)?.[1];
        fetched.asin = asin?.toUpperCase() || null;
        status.textContent = err.message;
      }
    };
    urlInput?.addEventListener('paste', () => setTimeout(unfurl, 0));
    urlInput?.addEventListener('change', unfurl);
    urlInput?.addEventListener('blur', unfurl);
    if (!item && navigator.clipboard?.readText) {
      // Offer the clipboard link without reading it unprompted: only on tap.
      const pasteBtn = pressable(h('button.chip.chip-sm', { type: 'button' }, '📋 Paste link'));
      pasteBtn.addEventListener('click', async () => {
        try { urlInput.value = await navigator.clipboard.readText(); unfurl(); } catch { toast('Clipboard not available, paste into the field'); }
      });
      urlInput?.closest('.field')?.append(pasteBtn);
    }
    await pending;
  }

  dispose(store.select((s) => s.ui.focus, () => {
    const next = pickDefaultBoard();
    if (next && next !== boardId) { boardId = next; render(); }
  }, { immediate: false }));
  dispose(store.select((s) => [s.me?.display_name, s.partner?.display_name, s.partner?.id], () => {
    if (loaded) { loaded = false; load(); }
  }, { immediate: false }));
  dispose(liveReload(['wishlist_boards', 'wishlist_items', 'wishlist_claims'], load));
  load();
  return dispose.run;
}
