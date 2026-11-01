/* Couples App · Bounty board + Love Coins
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Flow (enforced by the database, not just the UI):
 *   open → claimed (by you) → done (by the claimer) → approved (by the OTHER partner)
 * Approval mints coins into the append-only coin_ledger via a trigger.
 */
import { store, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic } from '../ui.js';
import { burst } from '../fx.js';
import { onTable, onResync } from '../realtime.js';
import { formSheet, confirmDialog } from '../sheet.js';
import { myId, nameOf, partnerName, section, disposer } from './common.js';

export function mount(host) {
  const dispose = disposer();
  const balances = h('div.coin-row');
  const list = h('div.task-list');
  const add = pressable(h('button.btn.btn-glass', { type: 'button' }, '+ Post a bounty'));
  add.addEventListener('click', createTask);
  host.append(section('bounty-card', 'Bounty board', balances, list, add));

  let tasks = [];
  let coins = {};

  async function load() {
    try {
      const [t, b] = await Promise.all([
        supabase.from('tasks').select('*').neq('status', 'approved').order('created_at', { ascending: false }).limit(40).then(unwrap),
        supabase.from('coin_balances').select('*').then(unwrap)
      ]);
      tasks = t;
      coins = Object.fromEntries(b.map((r) => [r.user_id, r.balance]));
    } catch (err) { console.warn('[bounty]', err); }
    render();
  }

  function render() {
    const { me, partner } = store.get();
    clear(balances).append(
      coinChip(me, coins[me?.id] || 0, 'You'),
      coinChip(partner, coins[partner?.id] || 0, partnerName())
    );
    clear(list);
    if (!tasks.length) { list.append(h('p.muted.small', 'No open bounties. Post a chore and put coins on it.')); return; }
    const order = { done: 0, claimed: 1, open: 2 };
    [...tasks].sort((a, b) => order[a.status] - order[b.status]).forEach((t) => list.append(taskRow(t)));
  }

  function coinChip(p, n, label) {
    return h('div.coin-chip', { style: { '--accent': p?.accent || '#ffd36e' } },
      h('span.coin', { 'aria-hidden': 'true' }, '🪙'),
      h('div', h('strong.coin-num', String(n)), h('span.muted.small', label)));
  }

  function taskRow(t) {
    const me = myId();
    const actions = [];
    const act = (label, cls, fn) => {
      const b = pressable(h(`button.btn.btn-sm.${cls}`, { type: 'button' }, label));
      b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } });
      actions.push(b);
    };
    if (t.status === 'open') act('Claim', 'btn-glass', () => move(t, 'claimed'));
    if (t.status === 'claimed' && t.claimed_by === me) {
      act('Done ✓', 'btn-primary', () => move(t, 'done'));
      act('Drop', 'btn-ghost', () => move(t, 'open'));
    }
    if (t.status === 'done' && t.claimed_by !== me) {
      act(`Approve +${t.reward_coins}`, 'btn-primary', () => move(t, 'approved'));
      act('Not yet', 'btn-ghost', () => move(t, 'claimed'));
    }
    if (t.status === 'open' && t.created_by === me) {
      act('Delete', 'btn-ghost', async () => {
        if (await confirmDialog('Delete this bounty?', t.title, { confirmLabel: 'Delete', danger: true })) {
          const { error } = await supabase.from('tasks').delete().eq('id', t.id);
          if (error) toast(error.message, { tone: 'error' });
        }
      });
    }
    const status = {
      open: 'Open',
      claimed: `${nameOf(t.claimed_by)} is on it`,
      done: t.claimed_by === me ? `Waiting for ${partnerName()} to approve` : `${nameOf(t.claimed_by)} says it’s done`
    }[t.status];
    return h('div.task-row.status-' + t.status,
      h('div.task-main',
        h('strong', t.title),
        h('span.muted.small', status)),
      h('span.task-reward', `🪙 ${t.reward_coins}`),
      actions.length ? h('div.task-actions', actions) : null);
  }

  async function move(t, status) {
    const patch = { status };
    if (status === 'claimed' && t.status === 'open') patch.claimed_by = myId();
    if (status === 'approved') patch.approved_by = myId();
    const { error } = await supabase.from('tasks').update(patch).eq('id', t.id);
    if (error) { toast(error.message, { tone: 'error' }); return; }
    haptic(10);
    if (status === 'approved') {
      burst({ kind: 'match', count: 30 });
      toast(`+${t.reward_coins} coins to ${nameOf(t.claimed_by)}`, { tone: 'ok' });
    }
  }

  async function createTask() {
    await formSheet('Post a bounty', [
      { name: 'title', label: 'Task', required: true, maxlength: 120, placeholder: 'Fold the laundry' },
      { name: 'details', label: 'Details (optional)', type: 'textarea', maxlength: 1000 },
      { name: 'reward', label: 'Reward (coins)', type: 'number', value: 10, min: 0, max: 1000, inputmode: 'numeric' }
    ], {
      submitLabel: 'Post bounty',
      onSubmit: async (v) => {
        const reward = Math.max(0, Math.min(1000, Math.round(Number(v.reward) || 0)));
        unwrap(await supabase.from('tasks').insert({ title: v.title, details: v.details || null, reward_coins: reward }));
      }
    });
  }

  dispose(onTable('tasks', (row, old, type) => {
    if (type === 'INSERT' && row.created_by !== myId()) toast(`🎯 New bounty: ${row.title}`);
    if (type === 'UPDATE' && row.status === 'done' && row.claimed_by !== myId()) toast(`✅ ${nameOf(row.claimed_by)} finished “${row.title}”. Approve it?`);
    load();
  }));
  dispose(onTable('coin_ledger', load));
  dispose(onResync(load));
  load();
  return dispose.run;
}
