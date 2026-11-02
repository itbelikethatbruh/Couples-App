/* Couples App · Sinking funds (savings jars)
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Each goal is a glass jar whose liquid rises as you save. Deposits go
 * through fund_adjust(), an atomic add, so two quick taps on two phones
 * both count.
 */
import { toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic } from '../ui.js';
import { tilt, burst } from '../fx.js';
import { openSheet, formSheet, confirmDialog } from '../sheet.js';
import { section, disposer, localDate } from '../spark/common.js';
import { fmt, parseCents, centsToInput, daysUntil, liveReload } from './common.js';

export function mount(host) {
  const dispose = disposer();
  const rail = h('div.jar-rail');
  const add = pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, '+ Goal'));
  add.addEventListener('click', () => editFund());
  host.append(section('funds-card', null, h('div.card-head', h('h2.card-title', '🫙 Savings goals'), add), rail));

  let funds = [];

  async function load() {
    try { funds = await supabase.from('sinking_funds').select('*').order('sort').order('created_at').then(unwrap); }
    catch (err) { console.warn('[funds]', err); }
    render();
  }

  function plan(f) {
    const left = Math.max(0, f.target_cents - f.saved_cents);
    if (!f.target_date || !left) return null;
    const days = daysUntil(f.target_date);
    if (days <= 0) return 'Target date passed';
    const months = Math.max(1, days / 30.44);
    return `${fmt(Math.ceil(left / months), { whole: true })}/mo to hit it`;
  }

  function render() {
    clear(rail);
    if (!funds.length) {
      rail.append(h('p.muted.small', 'Saving for a trip, a couch or a rainy day? Add a goal and watch the jar fill.'));
      return;
    }
    for (const f of funds) {
      const pct = Math.min(100, Math.round((f.saved_cents / f.target_cents) * 100));
      const jar = pressable(h('button.jar-tile' + (pct >= 100 ? '.full' : ''), { type: 'button', 'aria-label': `${f.name}, ${pct}% saved` },
        h('div.jar', { style: { '--fill': `${pct}%` } },
          h('div.jar-liquid', h('span.jar-wave'), h('span.jar-wave.two')),
          h('div.jar-glass'),
          h('span.jar-emoji', f.emoji || '💰'),
          h('span.jar-pct', `${pct}%`)),
        h('strong.jar-name', f.name),
        h('span.small', `${fmt(f.saved_cents, { whole: true })} of ${fmt(f.target_cents, { whole: true })}`),
        h('span.muted.small', plan(f) || (f.target_date ? `by ${new Date(`${f.target_date}T00:00:00`).toLocaleDateString([], { month: 'short', year: 'numeric' })}` : ' '))));
      jar.addEventListener('click', () => openFund(f));
      rail.append(tilt(jar, { max: 12 }));
    }
  }

  async function adjust(f, delta) {
    try {
      const before = f.saved_cents;
      const next = unwrap(await supabase.rpc('fund_adjust', { p_fund_id: f.id, p_delta_cents: delta }));
      haptic(delta > 0 ? [6, 24, 10] : 8);
      if (before < f.target_cents && next.saved_cents >= f.target_cents) {
        burst({ kind: 'match', count: 44 });
        toast(`🎉 ${f.name} is fully funded!`, { tone: 'ok', ms: 4000 });
      } else {
        toast(`${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))} · ${f.name}`, { tone: 'ok' });
      }
      return next;
    } catch (err) { toast(err.message, { tone: 'error' }); return null; }
  }

  function openFund(f) {
    const { body, close } = openSheet(`${f.emoji || '💰'} ${f.name}`);
    const amount = h('input.input', { inputmode: 'decimal', placeholder: 'Other amount', 'aria-label': 'Amount' });
    const quick = h('div.chip-row', [2500, 5000, 10000, 25000].map((c) => {
      const b = pressable(h('button.chip', { type: 'button' }, `+${fmt(c, { whole: true })}`));
      b.addEventListener('click', async () => { if (await adjust(f, c)) close(); });
      return b;
    }));
    const dep = pressable(h('button.btn.btn-primary', { type: 'button' }, 'Add'));
    const wd = pressable(h('button.btn.btn-ghost', { type: 'button' }, 'Withdraw'));
    const go = (sign) => async () => {
      const c = parseCents(amount.value);
      if (c == null) { amount.focus(); return; }
      if (await adjust(f, sign * c)) close();
    };
    dep.addEventListener('click', go(1));
    wd.addEventListener('click', go(-1));
    const edit = pressable(h('button.btn.btn-ghost.btn-block', { type: 'button' }, 'Edit goal'));
    edit.addEventListener('click', () => { close(); editFund(f); });
    body.append(
      h('p.lead', `${fmt(f.saved_cents)} saved of ${fmt(f.target_cents)}`),
      quick,
      h('div.amount-row', amount, dep, wd),
      edit);
  }

  async function editFund(f = null) {
    let removed = false;
    const del = f ? h('button.btn.btn-ghost.danger.btn-block', { type: 'button' }, 'Delete goal') : null;
    del?.addEventListener('click', async () => {
      if (!(await confirmDialog(`Delete ${f.name}?`, 'This only removes the tracker. No money moves.', { confirmLabel: 'Delete', danger: true }))) return;
      const { error } = await supabase.from('sinking_funds').delete().eq('id', f.id);
      if (error) toast(error.message, { tone: 'error' });
      else { removed = true; document.querySelector('.sheet-host .sheet-backdrop')?.click(); }
    });
    await formSheet(f ? 'Edit goal' : 'New savings goal', [
      { name: 'name', label: 'Goal', required: true, maxlength: 60, value: f?.name, placeholder: 'Cancun trip' },
      { name: 'emoji', label: 'Emoji', maxlength: 8, value: f?.emoji || '🏝️' },
      { name: 'target', label: 'Target ($)', inputmode: 'decimal', required: true, value: centsToInput(f?.target_cents), placeholder: '3000' },
      { name: 'saved', label: 'Already saved ($)', inputmode: 'decimal', value: f ? centsToInput(f.saved_cents) : '', placeholder: '0' },
      { name: 'date', label: 'Target date (optional)', type: 'date', value: f?.target_date || '' }
    ], {
      extra: del,
      onSubmit: async (v) => {
        if (removed) return;
        const target = parseCents(v.target);
        if (target == null) throw new Error('Enter a target amount');
        const saved = v.saved === '' ? 0 : parseCents(v.saved);
        if (v.saved !== '' && saved == null && Number(v.saved) !== 0) throw new Error('Check the amount saved');
        if (v.date && v.date < localDate()) throw new Error('Pick a date in the future');
        const row = { name: v.name, emoji: v.emoji || '💰', target_cents: target, target_date: v.date || null };
        if (f) {
          unwrap(await supabase.from('sinking_funds').update(row).eq('id', f.id));
          const diff = (saved || 0) - f.saved_cents;
          if (diff) unwrap(await supabase.rpc('fund_adjust', { p_fund_id: f.id, p_delta_cents: diff }));
        } else {
          unwrap(await supabase.from('sinking_funds').insert({ ...row, saved_cents: saved || 0, sort: funds.length }));
        }
        haptic(10);
      }
    });
  }

  dispose(liveReload(['sinking_funds'], load));
  load();
  return dispose.run;
}
