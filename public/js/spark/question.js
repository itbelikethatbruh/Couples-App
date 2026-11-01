/* Couples App · Blind Daily Question
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Your partner's answer is never sent to your phone until you have both
 * answered: RLS on question_answers hides it, so the blurred card shows
 * placeholder lines, not their real text. question_state() tells us only
 * WHETHER they answered. A broadcast nudges the other phone to re-check.
 */
import { store, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, icon, pressable, clear, haptic, timeAgo } from '../ui.js';
import { burst } from '../fx.js';
import { onTable, onBroadcast, onResync, broadcast } from '../realtime.js';
import { myId, nameOf, partnerName, localDate, section, disposer } from './common.js';

const CATEGORIES = {
  fun:    { label: 'Fun',    emoji: '🎈', hue: '#ffb547' },
  deep:   { label: 'Deep',   emoji: '🌊', hue: '#3d8bff' },
  spicy:  { label: 'Spicy',  emoji: '🔥', hue: '#ff2d78' },
  future: { label: 'Future', emoji: '🔭', hue: '#9b5cff' }
};

export function mount(host) {
  const dispose = disposer();
  const body = h('div.question-body');
  const card = section('question-card', null, body);
  host.append(card);

  let q = null;              // { assignment_id, category, prompt, for_date }
  let state = { my_answered: false, partner_answered: false, unlocked: false };
  let answers = [];
  let comments = [];
  let wasUnlocked = false;
  let loading = false;

  async function load({ deal = false, category = null } = {}) {
    if (loading) return;
    loading = true;
    try {
      const rows = unwrap(await supabase.rpc('get_daily_question', {
        p_date: localDate(), p_category: category, p_new: deal
      }));
      q = rows?.[0] || null;
      if (deal && q) broadcast('question:dealt', { assignment_id: q.assignment_id });
      await refresh();
    } catch (err) {
      toast(err.message, { tone: 'error' });
      render();
    } finally {
      loading = false;
    }
  }

  async function refresh() {
    if (!q) { render(); return; }
    const st = unwrap(await supabase.rpc('question_state', { p_assignment_id: q.assignment_id }));
    state = st?.[0] || state;
    answers = unwrap(await supabase.from('question_answers').select('*').eq('assignment_id', q.assignment_id));
    comments = state.unlocked
      ? unwrap(await supabase.from('question_comments').select('*').eq('assignment_id', q.assignment_id).order('created_at'))
      : [];
    render();
  }

  function render() {
    clear(body);
    if (!q) {
      body.append(h('p.muted', 'Loading today’s question…'));
      return;
    }
    const cat = CATEGORIES[q.category] || CATEGORIES.fun;
    card.style.setProperty('--q-hue', cat.hue);

    body.append(
      h('div.q-head',
        h('span.q-badge', `${cat.emoji} ${cat.label}`),
        h('span.muted.small', 'Daily question')),
      h('p.q-prompt', q.prompt)
    );

    const mine = answers.find((a) => a.user_id === myId());
    const theirs = answers.find((a) => a.user_id !== myId());

    if (!state.my_answered) {
      if (state.partner_answered) {
        body.append(h('div.q-nudge', icon('lock', { size: 16 }), ` ${partnerName()} answered. Answer to unlock both.`));
      }
      body.append(answerForm());
    } else if (!state.unlocked) {
      body.append(
        answerBubble(mine, true),
        lockedBubble()
      );
    } else {
      const justUnlocked = !wasUnlocked;
      body.append(
        answerBubble(mine, true, justUnlocked),
        answerBubble(theirs, false, justUnlocked),
        commentThread()
      );
      if (justUnlocked && wasUnlocked === false && answers.length === 2) {
        const r = card.getBoundingClientRect();
        burst({ kind: 'match', originX: r.left + r.width / 2, originY: r.top + 80, count: 36 });
        haptic([10, 40, 10]);
      }
    }
    wasUnlocked = state.unlocked;
    body.append(dealRow());
  }

  function answerForm() {
    const ta = h('textarea.input.textarea', { rows: 3, maxlength: 2000, placeholder: 'Your answer stays hidden until you both answer…', 'aria-label': 'Your answer' });
    const send = pressable(h('button.btn.btn-primary', { type: 'submit' }, icon('lock', { size: 16 }), ' Lock in answer'));
    const form = h('form.q-form', ta, send);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        unwrap(await supabase.from('question_answers').insert({ assignment_id: q.assignment_id, answer: text }));
        broadcast('question:answered', { assignment_id: q.assignment_id });
        haptic(12);
        await refresh();
      } catch (err) {
        toast(err.message, { tone: 'error' });
        send.disabled = false;
      }
    });
    return form;
  }

  function answerBubble(row, isMine, reveal = false) {
    if (!row) return null;
    const p = isMine ? store.get().me : store.get().partner;
    return h('div.q-answer' + (isMine ? '.mine' : '.theirs') + (reveal ? '.reveal' : ''),
      { style: { '--accent': p?.accent || '#ff2d78' } },
      h('div.q-answer-who', `${p?.avatar_emoji || '✨'} ${nameOf(row.user_id)}`),
      h('p.q-answer-text', row.answer));
  }

  function lockedBubble() {
    const p = store.get().partner;
    // Decoy lines only: the real answer is not on this device.
    return h('div.q-answer.theirs.locked', { style: { '--accent': p?.accent || '#7a5cff' } },
      h('div.q-answer-who', `${p?.avatar_emoji || '💞'} ${partnerName()}`),
      h('div.q-blur', { 'aria-hidden': 'true' }, h('span'), h('span'), h('span.short')),
      h('div.q-lock-badge', icon('lock', { size: 18 }),
        state.partner_answered ? ' Unlocks for you both now…' : ` Waiting for ${partnerName()}`));
  }

  function commentThread() {
    const list = h('div.q-comments', comments.map((c) => h('div.q-comment' + (c.user_id === myId() ? '.mine' : ''),
      h('span.q-comment-who', nameOf(c.user_id)),
      h('span.q-comment-body', c.body),
      h('span.muted.small', timeAgo(c.created_at)))));
    const input = h('input.input', { type: 'text', maxlength: 1000, placeholder: 'Reply…', 'aria-label': 'Comment' });
    const send = pressable(h('button.icon-btn.send-btn', { type: 'submit', 'aria-label': 'Send' }, icon('send', { size: 18 })));
    const form = h('form.q-comment-form', input, send);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      const { error } = await supabase.from('question_comments').insert({ assignment_id: q.assignment_id, body: text });
      if (error) { toast(error.message, { tone: 'error' }); input.value = text; }
    });
    return h('div.q-thread', list, form);
  }

  function dealRow() {
    const row = h('div.q-deal', h('span.muted.small', 'Deal another:'));
    for (const [key, c] of Object.entries(CATEGORIES)) {
      const b = pressable(h('button.chip.chip-sm', { type: 'button' }, `${c.emoji} ${c.label}`));
      b.addEventListener('click', () => load({ deal: true, category: key }));
      row.append(b);
    }
    return row;
  }

  // ---- realtime ----
  dispose(onBroadcast('question:answered', (p) => { if (p.assignment_id === q?.assignment_id) refresh(); }));
  dispose(onBroadcast('question:dealt', () => load()));
  dispose(onTable('question_answers', (row) => { if (row?.assignment_id === q?.assignment_id) refresh(); }));
  dispose(onTable('question_comments', (row, _o, type) => {
    if (type !== 'INSERT' || row.assignment_id !== q?.assignment_id) return;
    if (!comments.some((c) => c.id === row.id)) { comments.push(row); render(); }
  }));
  dispose(onResync(() => load()));

  load();
  return dispose.run;
}
