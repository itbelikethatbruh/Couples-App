/* Couples App · Love Coupon wallet
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Redeeming is a single INSERT; a database trigger checks your coin balance,
 * charges it, and refuses if you are short. Your partner then fulfils it.
 */
import { store, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic, timeAgo } from '../ui.js';
import { tilt } from '../fx.js';
import { onTable, onResync } from '../realtime.js';
import { formSheet, confirmDialog, celebrate } from '../sheet.js';
import { myId, nameOf, partnerName, section, disposer } from './common.js';

let defaultsEnsured = false;

export function mount(host) {
  const dispose = disposer();
  const wallet = h('div.coupon-rail');
  const pending = h('div.redemptions');
  const add = pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, '+ New coupon'));
  add.addEventListener('click', createCoupon);
  host.append(section('coupon-card', 'Love coupons', wallet, pending, add));

  let coupons = [];
  let redemptions = [];
  let balance = 0;

  async function load() {
    try {
      if (!defaultsEnsured) {
        defaultsEnsured = true;
        await supabase.rpc('ensure_couple_defaults');
      }
      const [c, r, b] = await Promise.all([
        supabase.from('coupons').select('*').eq('active', true).order('cost_coins').then(unwrap),
        supabase.from('coupon_redemptions').select('*').eq('status', 'pending').order('created_at', { ascending: false }).then(unwrap),
        supabase.from('coin_balances').select('*').eq('user_id', myId()).then(unwrap)
      ]);
      coupons = c; redemptions = r; balance = b[0]?.balance || 0;
    } catch (err) { console.warn('[coupons]', err); }
    render();
  }

  function render() {
    clear(wallet);
    for (const c of coupons) {
      const afford = balance >= c.cost_coins;
      const card = h('button.coupon' + (afford ? '' : '.locked'), { type: 'button', 'aria-label': `${c.title}, ${c.cost_coins} coins` },
        h('span.coupon-emoji', c.emoji),
        h('strong.coupon-title', c.title),
        c.description ? h('span.coupon-desc', c.description) : null,
        h('span.coupon-cost', `🪙 ${c.cost_coins}`));
      card.addEventListener('click', () => redeem(c));
      wallet.append(tilt(pressable(card), { max: 10 }));
    }
    clear(pending);
    if (redemptions.length) {
      pending.append(h('h3.section-title', 'Owed'));
      for (const r of redemptions) {
        const c = coupons.find((x) => x.id === r.coupon_id);
        const forMe = r.redeemed_by === myId();
        const row = h('div.redeem-row',
          h('span', c?.emoji || '🎟️'),
          h('div.task-main',
            h('strong', c?.title || 'Coupon'),
            h('span.muted.small', forMe ? `You redeemed · ${partnerName()} owes you · ${timeAgo(r.created_at)}` : `${nameOf(r.redeemed_by)} redeemed · you owe them`)));
        if (!forMe) {
          const done = pressable(h('button.btn.btn-sm.btn-primary', { type: 'button' }, 'Fulfilled'));
          done.addEventListener('click', async () => {
            const { error } = await supabase.from('coupon_redemptions').update({ status: 'fulfilled', fulfilled_at: new Date().toISOString() }).eq('id', r.id);
            if (error) toast(error.message, { tone: 'error' });
          });
          row.append(done);
        }
        pending.append(row);
      }
    }
  }

  async function redeem(c) {
    if (balance < c.cost_coins) { toast(`You need ${c.cost_coins - balance} more coins. Finish a bounty!`); return; }
    if (!(await confirmDialog(`Redeem “${c.title}”?`, `This spends ${c.cost_coins} of your ${balance} coins.`, { confirmLabel: 'Redeem' }))) return;
    const { error } = await supabase.from('coupon_redemptions').insert({ coupon_id: c.id });
    if (error) { toast(error.message, { tone: 'error' }); return; }
    haptic([10, 40, 10]);
    celebrate({ emoji: c.emoji, title: 'Coupon redeemed', body: `${partnerName()} has been notified. No take-backs.`, kind: 'love' });
  }

  async function createCoupon() {
    await formSheet('New coupon', [
      { name: 'title', label: 'Coupon', required: true, maxlength: 80, placeholder: 'Foot rub, 15 minutes' },
      { name: 'emoji', label: 'Emoji', maxlength: 8, value: '🎟️' },
      { name: 'description', label: 'Fine print (optional)', maxlength: 280 },
      { name: 'cost', label: 'Cost (coins)', type: 'number', value: 30, min: 1, max: 10000, inputmode: 'numeric' }
    ], {
      submitLabel: 'Add to wallet',
      onSubmit: async (v) => {
        unwrap(await supabase.from('coupons').insert({
          title: v.title, emoji: v.emoji || '🎟️', description: v.description || null,
          cost_coins: Math.max(1, Math.min(10000, Math.round(Number(v.cost) || 1)))
        }));
      }
    });
  }

  dispose(onTable('coupons', load));
  dispose(onTable('coin_ledger', load));
  dispose(onTable('coupon_redemptions', (row, _o, type) => {
    if (type === 'INSERT' && row.redeemed_by !== myId()) {
      toast(`🎟️ ${nameOf(row.redeemed_by)} redeemed a coupon. You owe them!`, { tone: 'love', ms: 4500 });
      haptic([20, 40, 20]);
    }
    load();
  }));
  dispose(onResync(load));
  load();
  return dispose.run;
}
