/* Couples App · Universal inbox
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Paste a TikTok, a product link, a restaurant, a grocery list or a quick
 * thought. The universal-inbox Edge Function files it with simple rules
 * (no AI): TikToks to the vault, links to the right wishlist board,
 * multi-line text to a checklist, one-liners to Quick notes.
 * Android's share sheet lands here too (manifest share_target).
 */
import { toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic, timeAgo } from '../ui.js';
import { burst } from '../fx.js';
import { section, disposer, nameOf } from '../spark/common.js';
import { liveReload, callFunction } from '../money/common.js';

const KIND_LABEL = {
  tiktok_videos: (r) => (r.duplicate ? '🎬 Already in the vault' : '🎬 TikTok vault'),
  wishlist_items: (r) => ({ amazon: '🎁 Wishlist', restaurants: '🍽️ Restaurants', vacations: '✈️ Vacations', events: '🎟️ Events' }[r.board_kind] || '🎁 Wishlist'),
  checklists: (r) => (r.items > 1 ? `📝 New list · ${r.items} items` : '📝 Quick notes')
};

export function mount(host) {
  const dispose = disposer();
  const input = h('textarea.input.textarea.inbox-input', {
    rows: 3, maxlength: 20000, 'aria-label': 'Paste anything',
    placeholder: 'Paste a TikTok, a link, or a list…\n- eggs\n- milk'
  });
  const pasteBtn = pressable(h('button.chip', { type: 'button' }, '📋 Paste'));
  const saveBtn = pressable(h('button.btn.btn-primary', { type: 'button' }, 'File it'));
  const recent = h('div.inbox-recent');

  host.append(section('inbox-card', null,
    h('div.card-head', h('h2.card-title', '📥 Drop anything'), pasteBtn),
    h('p.muted.small', 'TikToks go to the vault, links to the right wishlist, lists become checklists.'),
    input,
    h('div.btn-row', saveBtn),
    recent));

  async function submit(text, { url = '', title = '', source = 'paste' } = {}) {
    if (!text.trim() && !url.trim()) { input.focus(); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Filing…';
    try {
      const res = await callFunction('universal-inbox', { text, url, title, source });
      haptic([8, 30, 8]);
      const r = saveBtn.getBoundingClientRect();
      burst({ kind: 'match', count: 16, originX: r.left + r.width / 2, originY: r.top });
      toast(res?.message || 'Filed ✓', { tone: 'ok', ms: 3200 });
      input.value = '';
      window.dispatchEvent(new CustomEvent('us:inbox-filed', { detail: res?.routed }));
    } catch (err) {
      toast(err.message, { tone: 'error', ms: 4200 });
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'File it';
    }
  }

  saveBtn.addEventListener('click', () => submit(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(input.value); });
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) { toast('Clipboard is empty'); return; }
      input.value = text;
      submit(text);
    } catch {
      input.focus();
      toast('Long-press the box and tap Paste');
    }
  });

  // Android share sheet → /share-target → app.js stores it → we file it.
  function takePendingShare() {
    let shared = null;
    try {
      shared = JSON.parse(sessionStorage.getItem('us.pendingShare') || 'null');
      sessionStorage.removeItem('us.pendingShare');
    } catch { /* private mode */ }
    if (!shared) return;
    submit(shared.text || '', { url: shared.url || '', title: shared.title || '', source: 'share_sheet' });
  }
  window.addEventListener('us:share', takePendingShare);
  dispose(() => window.removeEventListener('us:share', takePendingShare));
  takePendingShare();

  async function load() {
    let rows = [];
    try {
      rows = await supabase.from('notes_inbox').select('id,created_by,source,raw_text,raw_url,routed_to,created_at')
        .order('created_at', { ascending: false }).limit(5).then(unwrap);
    } catch (err) { console.warn('[inbox]', err); }
    clear(recent);
    if (!rows.length) return;
    recent.append(h('p.eyebrow.small', 'Recently filed'));
    for (const r of rows) {
      const label = KIND_LABEL[r.routed_to?.table]?.(r.routed_to) || 'Filed';
      const what = (r.raw_url || r.raw_text || '').split('\n')[0].slice(0, 70);
      recent.append(h('div.inbox-row',
        h('span.inbox-dest', label),
        h('span.inbox-what', what || '—'),
        h('span.muted.small', `${nameOf(r.created_by)}${r.source === 'share_sheet' ? ' · shared' : ''} · ${timeAgo(r.created_at)}`)));
    }
  }

  dispose(liveReload(['notes_inbox'], load));
  load();
  return dispose.run;
}
