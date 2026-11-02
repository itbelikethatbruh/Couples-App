/* Couples App · Settle-up balance
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * One number: who owes whom. Split expenses and settlements feed the
 * ledger_lines view; settle_balance() nets it from the caller's side.
 * The beam tips toward whoever owes, in 3D.
 */
import { store, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic } from '../ui.js';
import { tilt, burst } from '../fx.js';
import { openSheet, confirmDialog } from '../sheet.js';
import { nameOf, partnerName, section, disposer } from '../spark/common.js';
import { fmt, liveReload } from './common.js';

export function mount(host) {
  const dispose = disposer();
  const body = h('div.settle-body');
  host.append(tilt(section('settle-card', null, body), { max: 6 }));

  let net = 0;

  async function load() {
    try {
      net = Number(unwrap(await supabase.rpc('settle_balance'))) || 0;
    } catch (err) { console.warn('[settle]', err); }
    render();
  }

  function render() {
    const { me, partner } = store.get();
    const owedToMe = net > 0;
    const square = net === 0;
    const headline = square
      ? 'All square ✨'
      : owedToMe ? `${partnerName()} owes you` : `You owe ${partnerName()}`;
    // Beam angle: tips down on the side of whoever owes. Saturates at $500.
    const tiltDeg = square ? 0 : Math.sign(net) * Math.min(14, 4 + Math.abs(net) / 5000);

    const settleBtn = pressable(h('button.btn.btn-primary', { type: 'button', disabled: square || !partner }, 'Settle up'));
    settleBtn.addEventListener('click', settle);
    const historyBtn = pressable(h('button.btn.btn-ghost', { type: 'button' }, 'History'));
    historyBtn.addEventListener('click', openHistory);

    clear(body).append(
      h('p.eyebrow', 'Settle-up'),
      h('div.settle-amount' + (square ? '.square' : owedToMe ? '.owed' : '.owe'),
        h('span.settle-label', headline),
        square ? null : h('strong.settle-num', fmt(Math.abs(net)))),
      h('div.beam-stage', { 'aria-hidden': 'true', style: { '--beam': `${tiltDeg}deg` } },
        h('div.beam',
          h('span.beam-seat.left', { style: { '--accent': me?.accent || '#ff2d78' } }, me?.avatar_emoji || '🙂'),
          h('span.beam-bar'),
          h('span.beam-seat.right', { style: { '--accent': partner?.accent || '#7a5cff' } }, partner?.avatar_emoji || '🙂')),
        h('span.beam-pivot')),
      h('p.muted.small', 'Split and “owed” expenses add up here. Joint-account spending doesn’t.'),
      h('div.btn-row', settleBtn, historyBtn));
  }

  async function settle() {
    const { me, partner } = store.get();
    if (!partner || net === 0) return;
    const amount = Math.abs(net);
    const from = net > 0 ? partner.id : me.id;
    const to = net > 0 ? me.id : partner.id;
    const ok = await confirmDialog(
      `Record ${fmt(amount)} paid?`,
      `${nameOf(from)} paid ${nameOf(to)} ${fmt(amount)} (Venmo, Zelle, cash…). This resets the balance to zero.`,
      { confirmLabel: 'Mark as paid' });
    if (!ok) return;
    try {
      unwrap(await supabase.from('settlements').insert({ from_user: from, to_user: to, amount_cents: amount, note: 'Settle up' }));
      haptic([10, 40, 10]);
      burst({ kind: 'match', count: 34 });
      toast('All square ✨', { tone: 'ok' });
    } catch (err) { toast(err.message, { tone: 'error' }); }
  }

  async function openHistory() {
    const { body: sheetBody } = openSheet('Who paid for what');
    const list = h('div.ledger-list', h('p.muted.small', 'Loading…'));
    sheetBody.append(list);
    try {
      const [exp, set] = await Promise.all([
        supabase.from('expenses').select('id,title,amount_cents,paid_by,split,spent_on')
          .neq('split', 'joint').order('spent_on', { ascending: false }).limit(40).then(unwrap),
        supabase.from('settlements').select('*').order('settled_on', { ascending: false }).limit(20).then(unwrap)
      ]);
      const me = store.get().me?.id;
      const rows = [
        ...exp.map((e) => {
          const owed = e.split === 'split_even' ? Math.round(e.amount_cents / 2) : e.amount_cents;
          return { date: e.spent_on, title: e.title, sub: `${nameOf(e.paid_by)} paid ${fmt(e.amount_cents)} · ${e.split === 'split_even' ? 'split 50/50' : 'owed in full'}`, delta: e.paid_by === me ? owed : -owed };
        }),
        ...set.map((s) => ({ date: s.settled_on, title: '🤝 Settled up', sub: `${nameOf(s.from_user)} paid ${nameOf(s.to_user)}`, delta: s.from_user === me ? s.amount_cents : -s.amount_cents }))
      ].sort((a, b) => (a.date < b.date ? 1 : -1));
      clear(list);
      if (!rows.length) { list.append(h('p.muted.small', 'Nothing yet. Add an expense and choose “Split 50/50” or “They owe me”.')); return; }
      for (const r of rows) {
        list.append(h('div.ledger-row',
          h('div', h('strong', r.title), h('span.muted.small', `${r.sub} · ${new Date(`${r.date}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}`)),
          h('span.ledger-delta' + (r.delta >= 0 ? '.pos' : '.neg'), `${r.delta >= 0 ? '+' : '−'}${fmt(Math.abs(r.delta))}`)));
      }
    } catch (err) {
      clear(list).append(h('p.form-error', err.message));
    }
  }

  dispose(store.select((s) => [s.me?.avatar_emoji, s.partner?.avatar_emoji, s.partner?.display_name], render, { immediate: false }));
  dispose(liveReload(['expenses', 'settlements'], load));
  load();
  return dispose.run;
}
