/* Couples App · Spending log + AI receipt scanner
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Log an expense by hand, or snap a receipt: the photo is shrunk on the
 * phone, stored privately, read by the scan-receipt Edge Function, and the
 * result opens in a review sheet. Nothing is booked until you tap Save.
 */
import { store, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic } from '../ui.js';
import { formSheet, confirmDialog } from '../sheet.js';
import { compressImage, uploadTo } from '../media.js';
import { nameOf, section, disposer, localDate } from '../spark/common.js';
import {
  fmt, parseCents, centsToInput, monthRange, BUCKETS, CATEGORIES, categoryLabel, categoryBucket,
  liveReload, callFunction
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
  const pending = h('div.receipt-queue');
  const list = h('div.expense-list');
  const fileInput = h('input', { type: 'file', accept: 'image/*,application/pdf', hidden: true });
  const addBtn = pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, '+ Expense'));
  const scanBtn = pressable(h('button.btn.btn-primary.btn-sm.scan-btn', { type: 'button' }, '📷 Scan receipt'));
  addBtn.addEventListener('click', () => editExpense());
  scanBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; fileInput.value = ''; if (f) scan(f); });

  host.append(section('spend-card', null,
    h('div.card-head', h('h2.card-title', '💳 Spending'), h('div.btn-row-tight', addBtn, scanBtn)),
    bar, legend, pending, list, fileInput));

  let expenses = [];
  let receipts = [];
  const busy = new Set();          // receipt ids being scanned on this phone

  async function load() {
    const { start, end } = monthRange();
    try {
      [expenses, receipts] = await Promise.all([
        supabase.from('expenses').select('*').gte('spent_on', start).lt('spent_on', end)
          .order('spent_on', { ascending: false }).order('created_at', { ascending: false }).limit(200).then(unwrap),
        supabase.from('receipts').select('*').order('created_at', { ascending: false }).limit(15).then(unwrap)
      ]);
      // Receipts already turned into an expense (any month) drop out of the queue.
      const ids = receipts.map((r) => r.id);
      if (ids.length) {
        const used = await supabase.from('expenses').select('receipt_id').in('receipt_id', ids).then(unwrap);
        const usedSet = new Set(used.map((u) => u.receipt_id));
        receipts = receipts.filter((r) => !usedSet.has(r.id));
      }
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

    // Receipt queue
    clear(pending);
    for (const r of receipts) {
      if (r.status === 'done' && r.total_cents == null && !r.merchant) continue;
      const scanning = busy.has(r.id) || r.status === 'processing' || r.status === 'pending';
      const review = pressable(h('button.btn.btn-sm.btn-primary', { type: 'button' }, r.status === 'error' ? 'Enter by hand' : 'Review'));
      review.addEventListener('click', () => editExpense(null, r));
      const retry = r.status === 'error' ? pressable(h('button.btn.btn-sm.btn-ghost', { type: 'button' }, 'Retry')) : null;
      retry?.addEventListener('click', () => runScan(r.id));
      const dismiss = pressable(h('button.icon-btn', { type: 'button', 'aria-label': 'Discard receipt' }, '×'));
      dismiss.addEventListener('click', () => discard(r));
      pending.append(h('div.receipt-row.status-' + (scanning ? 'scanning' : r.status),
        h('span.receipt-icon', { 'aria-hidden': 'true' }, scanning ? h('span.scan-beam') : r.status === 'error' ? '⚠️' : '🧾'),
        h('div.receipt-main',
          h('strong', scanning ? 'Reading receipt…' : r.merchant || 'Receipt'),
          h('span.muted.small', scanning ? 'This takes a few seconds' : r.status === 'error' ? (r.error || 'Could not read it') :
            [r.total_cents != null ? fmt(r.total_cents) : null, r.purchased_on, (r.line_items || []).length ? `${r.line_items.length} items` : null].filter(Boolean).join(' · '))),
        scanning ? null : h('div.task-actions', review, retry, dismiss)));
    }

    // Expense list
    clear(list);
    if (!expenses.length) {
      list.append(h('p.muted.small', 'No spending logged this month. Tap “Scan receipt” after your next store run.'));
      return;
    }
    for (const e of expenses.slice(0, 40)) {
      const row = h('button.expense-row', { type: 'button' },
        h('span.expense-emoji', { 'aria-hidden': 'true' }, categoryLabel(e.category).split(' ')[0]),
        h('span.expense-main',
          h('strong', e.title),
          h('span.muted.small', `${nameOf(e.paid_by)} paid · ${new Date(`${e.spent_on}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
            e.split !== 'joint' ? h('span.chip.chip-sm.split-chip', SPLITS[e.split].short) : null,
            e.receipt_id ? ' · 🧾' : null)),
        h('span.expense-amt', fmt(e.amount_cents)));
      row.addEventListener('click', () => editExpense(e));
      list.append(row);
    }
    if (expenses.length > 40) list.append(h('p.muted.small', `+ ${expenses.length - 40} more this month`));
  }

  async function discard(r) {
    if (!(await confirmDialog('Discard this receipt?', 'The photo is deleted too.', { confirmLabel: 'Discard', danger: true }))) return;
    try {
      unwrap(await supabase.from('receipts').delete().eq('id', r.id));
      await supabase.storage.from('receipts').remove([r.storage_path]);   // only works for your own uploads
    } catch (err) { toast(err.message, { tone: 'error' }); }
  }

  async function scan(file) {
    const isPdf = file.type === 'application/pdf';
    if (isPdf && file.size > 8 * 1024 * 1024) { toast('That PDF is over 8 MB', { tone: 'error' }); return; }
    scanBtn.disabled = true;
    try {
      const blob = isPdf ? file : await compressImage(file, { maxEdge: 2000, quality: 0.85 });
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${isPdf ? 'pdf' : 'jpg'}`;
      const path = await uploadTo('receipts', name, blob, isPdf ? 'application/pdf' : 'image/jpeg');
      const row = unwrap(await supabase.from('receipts').insert({ storage_path: path }).select('*').single());
      receipts.unshift(row);
      haptic(8);
      await runScan(row.id);
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      scanBtn.disabled = false;
    }
  }

  async function runScan(id) {
    busy.add(id);
    render();
    try {
      const { receipt } = await callFunction('scan-receipt', { receipt_id: id });
      busy.delete(id);
      receipts = receipts.map((r) => (r.id === id ? receipt : r));
      render();
      haptic([8, 30, 8]);
      editExpense(null, receipt);
    } catch (err) {
      busy.delete(id);
      toast(err.message, { tone: 'error', ms: 4200 });
      load();
    }
  }

  async function editExpense(e = null, receipt = null) {
    const { me, partner } = store.get();
    const ai = receipt?.ai_raw || {};
    let removed = false;
    const del = e ? h('button.btn.btn-ghost.danger.btn-block', { type: 'button' }, 'Delete expense') : null;
    del?.addEventListener('click', async () => {
      if (!(await confirmDialog('Delete this expense?', e.title, { confirmLabel: 'Delete', danger: true }))) return;
      const { error } = await supabase.from('expenses').delete().eq('id', e.id);
      if (error) toast(error.message, { tone: 'error' });
      else { removed = true; document.querySelector('.sheet-host .sheet-backdrop')?.click(); }
    });
    const items = receipt?.line_items?.length
      ? h('details.receipt-items',
          h('summary', `${receipt.line_items.length} items on the receipt`),
          h('ul', receipt.line_items.slice(0, 60).map((li) =>
            h('li', h('span', `${li.quantity && li.quantity !== 1 ? `${li.quantity}× ` : ''}${li.name}`), h('span.muted', li.amount_cents != null ? fmt(li.amount_cents) : '')))))
      : null;
    const extra = h('div', items, del);
    const cat = e?.category || receipt?.category || 'groceries';
    const people = [{ value: me?.id, label: me?.display_name || 'Me' }, ...(partner ? [{ value: partner.id, label: partner.display_name }] : [])];

    await formSheet(e ? 'Edit expense' : receipt ? 'Check the receipt' : 'Add expense', [
      { name: 'title', label: 'What was it', required: true, maxlength: 120,
        value: e?.title || receipt?.merchant || '', placeholder: 'Trader Joe’s' },
      { name: 'amount', label: 'Amount ($)', inputmode: 'decimal', required: true,
        value: centsToInput(e?.amount_cents ?? receipt?.total_cents ?? null), placeholder: '0.00',
        hint: receipt && ai.tax != null ? `Includes tax ${ai.tax}${ai.tip ? ` and tip ${ai.tip}` : ''}` : null },
      { name: 'date', label: 'Date', type: 'date', required: true, value: e?.spent_on || receipt?.purchased_on || localDate() },
      { name: 'category', label: 'Category', type: 'select', value: cat, options: CATEGORIES.map(([value, label]) => ({ value, label })) },
      { name: 'bucket', label: 'Budget bucket', type: 'select', value: e?.bucket || ai.bucket || categoryBucket(cat),
        options: Object.entries(BUCKETS).map(([value, b]) => ({ value, label: `${b.emoji} ${b.label}` })) },
      { name: 'paid_by', label: 'Who paid', type: 'select', value: e?.paid_by || me?.id, options: people },
      { name: 'split', label: 'How to split', type: 'select', value: e?.split || 'joint',
        options: Object.entries(SPLITS).map(([value, s]) => ({ value, label: s.label })) }
    ], {
      submitLabel: e ? 'Save' : 'Add expense',
      extra,
      onSubmit: async (v) => {
        if (removed) return;
        const cents = parseCents(v.amount);
        if (cents == null) throw new Error('Enter an amount');
        if (v.split !== 'joint' && !partner) throw new Error('Splitting needs your partner to join first');
        const row = { title: v.title, amount_cents: cents, spent_on: v.date, category: v.category, bucket: v.bucket, paid_by: v.paid_by, split: v.split };
        if (e) unwrap(await supabase.from('expenses').update(row).eq('id', e.id));
        else unwrap(await supabase.from('expenses').insert({ ...row, receipt_id: receipt?.id || null }));
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

  dispose(liveReload(['expenses', 'receipts'], load));
  load();
  return dispose.run;
}
