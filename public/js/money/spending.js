/* Couples App · Spending log
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Log what you spend, who paid, and how it splits. The category bar shows
 * where this month's money went; split expenses feed the settle-up card.
 */
import { store, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic } from '../ui.js';
import { formSheet, confirmDialog } from '../sheet.js';
import { nameOf, section, disposer, localDate } from '../spark/common.js';
import {
  fmt, parseCents, centsToInput, monthRange, BUCKETS, CATEGORIES, categoryLabel, categoryBucket,
  liveReload
} from './common.js';

const SPLITS = {
  joint:      { label: 'Shared money · nobody owes', short: 'Joint' },
  split_even: { label: 'Split 50/50', short: '50/50' },
  full_owed:  { label: 'The other one owes all of it', short: 'Owed' }
};

export function mount(host) {
  const dispose = disposer();
  const bar = h('div.cat-bar', { role: 'img', 'aria-label': 'Spending by category' });
  const legend = h('div.cat-legend');
  const list = h('div.expense-list');
  const addBtn = pressable(h('button.btn.btn-primary.btn-sm', { type: 'button' }, '+ Expense'));
  addBtn.addEventListener('click', () => editExpense());

  host.append(section('spend-card', null,
    h('div.card-head', h('h2.card-title', '💳 Spending'), addBtn),
    bar, legend, list));

  let expenses = [];

  async function load() {
    const { start, end } = monthRange();
    try {
      expenses = await supabase.from('expenses').select('*').gte('spent_on', start).lt('spent_on', end)
        .order('spent_on', { ascending: false }).order('created_at', { ascending: false }).limit(200).then(unwrap);
    } catch (err) { console.warn('[spending]', err); }
    render();
  }

  function render() {
    // Category bar (this month)
    const byCat = new Map();
    for (const e of expenses) byCat.set(e.category || 'other', (byCat.get(e.category || 'other') || 0) + Number(e.amount_cents));
    const total = [...byCat.values()].reduce((a, b) => a + b, 0);
    const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    const palette = ['#ff2d78', '#9b5cff', '#5b5bff', '#3ee6a8', '#ffd36e', '#ff8a5b', '#5bd2ff'];
    clear(bar); clear(legend);
    top.forEach(([cat, cents], i) => {
      const c = palette[i % palette.length];
      bar.append(h('span.cat-seg', { style: { flexGrow: String(cents), '--c': c }, title: `${categoryLabel(cat)} ${fmt(cents)}` }));
      if (i < 5) legend.append(h('span.cat-key', { style: { '--c': c } }, `${categoryLabel(cat)} ${Math.round(cents * 100 / total)}%`));
    });
    bar.hidden = !total;

    // Expense list
    clear(list);
    if (!expenses.length) {
      list.append(h('p.muted.small', 'No spending logged this month. Tap “+ Expense” after your next store run.'));
      return;
    }
    for (const e of expenses.slice(0, 40)) {
      const row = h('button.expense-row', { type: 'button' },
        h('span.expense-emoji', { 'aria-hidden': 'true' }, categoryLabel(e.category).split(' ')[0]),
        h('span.expense-main',
          h('strong', e.title),
          h('span.muted.small', `${nameOf(e.paid_by)} paid · ${new Date(`${e.spent_on}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
            e.split !== 'joint' ? h('span.chip.chip-sm.split-chip', SPLITS[e.split].short) : null)),
        h('span.expense-amt', fmt(e.amount_cents)));
      row.addEventListener('click', () => editExpense(e));
      list.append(row);
    }
    if (expenses.length > 40) list.append(h('p.muted.small', `+ ${expenses.length - 40} more this month`));
  }

  async function editExpense(e = null) {
    const { me, partner } = store.get();
    let removed = false;
    const del = e ? h('button.btn.btn-ghost.danger.btn-block', { type: 'button' }, 'Delete expense') : null;
    del?.addEventListener('click', async () => {
      if (!(await confirmDialog('Delete this expense?', e.title, { confirmLabel: 'Delete', danger: true }))) return;
      const { error } = await supabase.from('expenses').delete().eq('id', e.id);
      if (error) toast(error.message, { tone: 'error' });
      else { removed = true; document.querySelector('.sheet-host .sheet-backdrop')?.click(); }
    });
    const cat = e?.category || 'groceries';
    const people = [{ value: me?.id, label: me?.display_name || 'Me' }, ...(partner ? [{ value: partner.id, label: partner.display_name }] : [])];

    await formSheet(e ? 'Edit expense' : 'Add expense', [
      { name: 'title', label: 'What was it', required: true, maxlength: 120,
        value: e?.title || '', placeholder: 'Trader Joe’s' },
      { name: 'amount', label: 'Amount ($)', inputmode: 'decimal', required: true,
        value: centsToInput(e?.amount_cents ?? null), placeholder: '0.00' },
      { name: 'date', label: 'Date', type: 'date', required: true, value: e?.spent_on || localDate() },
      { name: 'category', label: 'Category', type: 'select', value: cat, options: CATEGORIES.map(([value, label]) => ({ value, label })) },
      { name: 'bucket', label: 'Budget bucket', type: 'select', value: e?.bucket || categoryBucket(cat),
        options: Object.entries(BUCKETS).map(([value, b]) => ({ value, label: `${b.emoji} ${b.label}` })) },
      { name: 'paid_by', label: 'Who paid', type: 'select', value: e?.paid_by || me?.id, options: people },
      { name: 'split', label: 'How to split', type: 'select', value: e?.split || 'joint',
        options: Object.entries(SPLITS).map(([value, s]) => ({ value, label: s.label })) }
    ], {
      submitLabel: e ? 'Save' : 'Add expense',
      extra: del,
      onSubmit: async (v) => {
        if (removed) return;
        const cents = parseCents(v.amount);
        if (cents == null) throw new Error('Enter an amount');
        if (v.split !== 'joint' && !partner) throw new Error('Splitting needs your partner to join first');
        const row = { title: v.title, amount_cents: cents, spent_on: v.date, category: v.category, bucket: v.bucket, paid_by: v.paid_by, split: v.split };
        if (e) unwrap(await supabase.from('expenses').update(row).eq('id', e.id));
        else unwrap(await supabase.from('expenses').insert(row));
        haptic(10);
        if (!e) toast(`${fmt(cents)} logged`, { tone: 'ok' });
      }
    });
  }

  // The category select drives the bucket default while the sheet is open.
  const onChange = (ev) => {
    const sel = ev.target;
    if (sel?.name !== 'category') return;
    const bucket = sel.form?.querySelector('select[name=bucket]');
    if (bucket && !bucket.dataset.touched) bucket.value = categoryBucket(sel.value);
  };
  const onTouch = (ev) => { if (ev.target?.name === 'bucket') ev.target.dataset.touched = '1'; };
  document.addEventListener('change', onChange);
  document.addEventListener('input', onTouch);
  dispose(() => { document.removeEventListener('change', onChange); document.removeEventListener('input', onTouch); });

  dispose(liveReload(['expenses'], load));
  load();
  return dispose.run;
}
