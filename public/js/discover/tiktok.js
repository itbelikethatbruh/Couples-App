/* Couples App · TikTok vault
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Every TikTok either of you shares (from the app, the Android share sheet
 * or the iPhone Shortcut) lands here. Unwatched ones from your partner glow.
 * Tap to play it inline with TikTok's official embed player, react, and
 * talk about it. "Watched" is per person, so each of you sees your own
 * unwatched count.
 */
import { store, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic, timeAgo } from '../ui.js';
import { tilt, burst } from '../fx.js';
import { openSheet, confirmDialog } from '../sheet.js';
import { section, disposer, nameOf } from '../spark/common.js';
import { liveReload } from '../money/common.js';

const REACTIONS = ['😂', '😍', '🔥', '😮', '🥹', '💀'];
const FILTERS = [['all', 'All'], ['new', 'Unwatched'], ['mine', 'Sent by me'], ['theirs', 'Sent to me']];

export function mount(host) {
  const dispose = disposer();
  const chips = h('div.chip-row.tt-filters', { role: 'tablist' });
  const grid = h('div.tt-grid');
  const count = h('span.tt-count.muted.small');
  host.append(section('tiktok-card', null,
    h('div.card-head', h('h2.card-title', '🎬 TikTok vault'), count),
    chips, grid));

  let videos = [];
  let views = [];
  let reactions = [];
  let comments = [];
  let filter = 'all';
  let open = null;                 // { id, refresh }

  const me = () => store.get().me?.id;
  const watchedByMe = (v) => views.some((w) => w.video_id === v.id && w.user_id === me());
  const isNew = (v) => v.sent_by !== me() && !watchedByMe(v);

  async function load() {
    try {
      [videos, views, reactions, comments] = await Promise.all([
        supabase.from('tiktok_videos').select('*').order('created_at', { ascending: false }).limit(300).then(unwrap),
        supabase.from('tiktok_views').select('*').then(unwrap),
        supabase.from('tiktok_reactions').select('*').then(unwrap),
        supabase.from('tiktok_comments').select('*').order('created_at').then(unwrap)
      ]);
    } catch (err) { console.warn('[tiktok]', err); }
    render();
    open?.refresh();
  }

  function render() {
    clear(chips);
    for (const [id, label] of FILTERS) {
      const n = id === 'new' ? videos.filter(isNew).length : null;
      const c = pressable(h('button.chip' + (filter === id ? '.active' : ''), { type: 'button', role: 'tab', 'aria-selected': String(filter === id) },
        label, n ? h('span.chip-badge', String(n)) : null));
      c.addEventListener('click', () => { filter = id; render(); });
      chips.append(c);
    }
    const unwatched = videos.filter(isNew).length;
    count.textContent = videos.length ? `${videos.length} saved${unwatched ? ` · ${unwatched} new` : ''}` : '';

    const shown = videos.filter((v) =>
      filter === 'new' ? isNew(v) : filter === 'mine' ? v.sent_by === me() : filter === 'theirs' ? v.sent_by !== me() : true);
    clear(grid);
    if (!shown.length) {
      grid.append(h('p.muted.small.tt-empty', videos.length
        ? 'Nothing here with this filter.'
        : 'Share a TikTok to this app (Android share sheet, the iPhone Shortcut below, or paste the link above) and it shows up here for both of you.'));
      return;
    }
    for (const v of shown) {
      const mine = reactions.filter((r) => r.video_id === v.id);
      const talk = comments.filter((c) => c.video_id === v.id).length;
      const thumb = h('div.tt-thumb');
      if (v.thumbnail_url) {
        const img = h('img', { src: v.thumbnail_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
        img.addEventListener('error', () => img.remove());   // TikTok thumbnail links expire after a while
        thumb.append(img);
      }
      thumb.append(h('span.tt-play', { 'aria-hidden': 'true' }, '▶'));
      const tile = pressable(h('button.tt-tile' + (isNew(v) ? '.is-new' : ''), { type: 'button', 'aria-label': v.title || 'TikTok' },
        thumb,
        isNew(v) ? h('span.tt-new', 'New') : null,
        h('span.tt-meta',
          h('strong.tt-title', v.title || (v.author_name ? `@${v.author_name}` : 'TikTok')),
          h('span.muted.small', `${nameOf(v.sent_by)} · ${timeAgo(v.created_at)}`),
          (mine.length || talk) ? h('span.tt-social', [...new Set(mine.map((r) => r.emoji))].slice(0, 4).join(''), talk ? ` 💬${talk}` : '') : null)));
      tile.addEventListener('click', () => play(v));
      grid.append(tilt(tile, { max: 10 }));
    }
  }

  async function markWatched(v) {
    if (watchedByMe(v)) return;
    const { error } = await supabase.from('tiktok_views').upsert({ video_id: v.id }, { onConflict: 'video_id,user_id', ignoreDuplicates: true });
    if (!error) { views.push({ video_id: v.id, user_id: me() }); render(); }
  }

  function play(v) {
    const { body, close } = openSheet(v.author_name ? `@${v.author_name}` : 'TikTok', { onClose: () => { open = null; } });
    const frame = h('div.tt-frame',
      h('iframe', {
        src: `https://www.tiktok.com/player/v1/${v.video_id}?autoplay=1&music_info=1&description=1&rel=0`,
        title: v.title || 'TikTok video',
        allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture',
        loading: 'eager',
        referrerpolicy: 'strict-origin-when-cross-origin'
      }));
    const reactRow = h('div.tt-react');
    const thread = h('div.tt-thread');
    const say = h('input.input', { placeholder: 'Say something…', maxlength: 1000, 'aria-label': 'Comment' });
    const send = pressable(h('button.btn.btn-primary.btn-sm', { type: 'button' }, 'Send'));
    const openLink = h('a.btn.btn-ghost.btn-sm', { href: v.share_url, target: '_blank', rel: 'noopener' }, 'Open in TikTok');
    const del = pressable(h('button.btn.btn-ghost.btn-sm.danger', { type: 'button' }, 'Remove'));

    function refresh() {
      clear(reactRow);
      for (const e of REACTIONS) {
        const who = reactions.filter((r) => r.video_id === v.id && r.emoji === e);
        const mineR = who.find((r) => r.user_id === me());
        const b = pressable(h('button.tt-emoji' + (mineR ? '.on' : ''), { type: 'button', 'aria-pressed': String(Boolean(mineR)) },
          e, who.length ? h('span.tt-emoji-n', String(who.length)) : null));
        b.addEventListener('click', async () => {
          haptic(6);
          if (mineR) {
            const { error } = await supabase.from('tiktok_reactions').delete().eq('id', mineR.id);
            if (error) toast(error.message, { tone: 'error' });
          } else {
            const { error } = await supabase.from('tiktok_reactions').insert({ video_id: v.id, emoji: e });
            if (error) toast(error.message, { tone: 'error' });
            else { const r = b.getBoundingClientRect(); burst({ kind: 'love', count: 10, originX: r.left + r.width / 2, originY: r.top }); }
          }
        });
        reactRow.append(b);
      }
      clear(thread);
      const list = comments.filter((c) => c.video_id === v.id);
      if (!list.length) thread.append(h('p.muted.small', v.note ? `“${v.note}”` : 'No comments yet.'));
      else {
        if (v.note) thread.append(h('p.muted.small', `${nameOf(v.sent_by)}: “${v.note}”`));
        for (const c of list) {
          thread.append(h('div.tt-comment' + (c.user_id === me() ? '.mine' : ''),
            h('strong', nameOf(c.user_id)), h('span', c.body), h('span.muted.small', timeAgo(c.created_at))));
        }
      }
    }
    open = { id: v.id, refresh };

    async function post() {
      const text = say.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        unwrap(await supabase.from('tiktok_comments').insert({ video_id: v.id, body: text }));
        say.value = '';
      } catch (err) { toast(err.message, { tone: 'error' }); }
      finally { send.disabled = false; }
    }
    send.addEventListener('click', post);
    say.addEventListener('keydown', (e) => { if (e.key === 'Enter') post(); });
    del.addEventListener('click', async () => {
      if (!(await confirmDialog('Remove this TikTok?', 'It disappears from the vault for both of you.', { confirmLabel: 'Remove', danger: true }))) return;
      const { error } = await supabase.from('tiktok_videos').delete().eq('id', v.id);
      if (error) toast(error.message, { tone: 'error' }); else close();
    });

    body.append(frame,
      v.title ? h('p.tt-caption', v.title) : null,
      reactRow, thread,
      h('div.amount-row', say, send),
      h('div.btn-row-tight', openLink, del));
    refresh();
    markWatched(v);
  }

  // A share filed from the inbox card above: jump straight to it.
  const onFiled = (e) => {
    if (e.detail?.table !== 'tiktok_videos') return;
    setTimeout(() => { filter = 'all'; load(); }, 200);
  };
  window.addEventListener('us:inbox-filed', onFiled);
  dispose(() => window.removeEventListener('us:inbox-filed', onFiled));

  dispose(liveReload(['tiktok_videos', 'tiktok_views', 'tiktok_reactions', 'tiktok_comments'], load));
  load();
  return dispose.run;
}
