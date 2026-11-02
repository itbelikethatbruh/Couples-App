/* Couples App · Recurring bills
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Upcoming bills sorted by due date. "Paid" calls pay_bill(), which logs
 * the payment and rolls the due date forward in one transaction, so both
 * phones agree even if you both tap at once.
 */
import { store, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic } from '../ui.js';
import { burst } from '../fx.js';
import { formSheet, confirmDialog } from '../sheet.js';
import { nameOf, section, disposer, localDate } from '../spark/common.js';
import { fmt, parseCents, centsToInput, dueLabel, daysUntil, monthRange, BUCKETS, liveReload } from './common.js';

const RECUR = { monthly: 'Every month', weekly: 'Every week', yearly: 'Every year', none: 'One time' };

export function mount(host) {
  const dispose = disposer();
  const summary = h('p.muted.small.bills-summary');
  const list = h('div.bill-list');
  const paidWrap = h('div.bill-paid');
  const add = pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, '+ Bill'));
  add.addEventListener('click', () => editBill());
  host.append(section('bills-card', null,
    h('div.card-head', h('h2.card-title', '🧾 Bills'), add),
    summary, list, paidWrap));

  let bills = [];
  let payments = [];
  let showPaid = false;

  async function load() {
    const { start } = monthRange();
    try {
      [bills, payments] = await Promise.all([
        supabase.from('bills').select('*').eq('active', true).order('next_due_on').then(unwrap),
        supabase.from('bill_payments').select('*').gte('paid_at', `${start}T00:00:00`).order('paid_at', { ascending: false }).then(unwrap)
      ]);
    } catch (err) { console.warn('[bills]', err); }
    render();
  }

  function render() {
    clear(list);
    const soon = bills.filter((b) => daysUntil(b.next_due_on) <= 7);
    const late = bills.filter((b) => daysUntil(b.next_due_on) < 0);
    const monthTotal = bills.filter((b) => b.recurrence === 'monthly').reduce((s, b) => s + Number(b.amount_cents), 0);
    summary.textContent = bills.length
      ? [late.length ? `${late.length} overdue` : null,
         `${soon.length} due this week (${fmt(soon.reduce((s, b) => s + Number(b.amount_cents), 0))})`,
         `${fmt(monthTotal, { whole: true })}/mo in recurring bills`].filter(Boolean).join(' · ')
      : '';
    if (!bills.length) list.append(h('p.muted.small', 'Add rent, phone, streaming, car insurance… You’ll both see what’s due next.'));
    for (const b of bills) list.append(billRow(b));
    renderPaid();
  }

  function billRow(b) {
    const due = dueLabel(b.next_due_on);
    const pay = pressable(h('button.btn.btn-sm' + (due.tone === 'late' || due.tone === 'today' ? '.btn-primary' : '.btn-glass'), { type: 'button' }, 'Paid ✓'));
    pay.addEventListener('click', async (e) => {
      e.stopPropagation();
      pay.disabled = true;
      try {
        const next = unwrap(await supabase.rpc('pay_bill', { p_bill_id: b.id, p_period: b.next_due_on }));
        haptic([8, 30, 8]);
        const r = pay.getBoundingClientRect();
        burst({ kind: 'match', count: 18, originX: r.left + r.width / 2, originY: r.top });
        toast(next?.active === false ? `${b.name} paid ✓` : `${b.name} paid ✓ Next due ${new Date(`${next.next_due_on}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}`, { tone: 'ok' });
      } catch (err) {
        if (/already marked paid/.test(err.message)) { toast(`${b.name} was already marked paid`, { tone: 'ok' }); return; }
        toast(err.message, { tone: 'error' }); pay.disabled = false;
      }
    });
    const row = h('button.bill-row.due-' + due.tone, { type: 'button' },
      h('span.bill-icon', { 'aria-hidden': 'true', style: { '--c': BUCKETS[b.bucket]?.color } }, (b.name || '?').trim().charAt(0).toUpperCase()),
      h('span.bill-main',
        h('span.bill-top', h('strong', b.name), h('span.bill-amt', fmt(b.amount_cents))),
        h('span.small.bill-due', h('span', due.text),
          b.autopay ? h('span.chip.chip-sm.bill-chip', 'Autopay') : null,
          b.responsible ? h('span.muted', `· ${nameOf(b.responsible)}`) : null)));
    row.addEventListener('click', () => editBill(b));
    return h('div.bill-row-wrap', row, pay);
  }

  function renderPaid() {
    clear(paidWrap);
    if (!payments.length) return;
    const total = payments.reduce((s, p) => s + Number(p.amount_cents), 0);
    const toggle = pressable(h('button.link-btn', { type: 'button', 'aria-expanded': String(showPaid) },
      `${showPaid ? '▾' : '▸'} Paid this month · ${payments.length} · ${fmt(total)}`));
    toggle.addEventListener('click', () => { showPaid = !showPaid; renderPaid(); });
    paidWrap.append(toggle);
    if (!showPaid) return;
    const latestByBill = new Map();
    for (const p of payments) {
      const cur = latestByBill.get(p.bill_id);
      if (!cur || p.period_due_on > cur.period_due_on) latestByBill.set(p.bill_id, p);
    }
    const names = Object.fromEntries(bills.map((b) => [b.id, b.name]));
    for (const p of payments) {
      const undo = latestByBill.get(p.bill_id)?.id === p.id
        ? pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, 'Undo'))
        : null;
      undo?.addEventListener('click', async () => {
        try { unwrap(await supabase.rpc('undo_bill_payment', { p_payment_id: p.id })); toast('Payment undone'); }
        catch (err) { toast(err.message, { tone: 'error' }); }
      });
      paidWrap.append(h('div.paid-row',
        h('span', `✓ ${names[p.bill_id] || 'Bill'}`),
        h('span.muted.small', `${nameOf(p.paid_by)} · ${new Date(p.paid_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`),
        h('span.paid-amt', fmt(p.amount_cents)),
        undo));
    }
  }

  async function editBill(b = null) {
    const { me, partner } = store.get();
    let stopped = false;
    const stop = b ? h('button.btn.btn-ghost.danger.btn-block', { type: 'button' }, 'Stop tracking this bill') : null;
    stop?.addEventListener('click', async () => {
      if (!(await confirmDialog(`Stop tracking ${b.name}?`, 'Past payments stay in your budget history.', { confirmLabel: 'Stop tracking', danger: true }))) return;
      const { error } = await supabase.from('bills').update({ active: false }).eq('id', b.id);
      if (error) toast(error.message, { tone: 'error' });
      else { stopped = true; document.querySelector('.sheet-host .sheet-backdrop')?.click(); }
    });
    await formSheet(b ? 'Edit bill' : 'Add a bill', [
      { name: 'name', label: 'Name', required: true, maxlength: 80, value: b?.name, placeholder: 'Rent' },
      { name: 'amount', label: 'Amount ($)', inputmode: 'decimal', required: true, value: centsToInput(b?.amount_cents), placeholder: '1450.00' },
      { name: 'next', label: b ? 'Next due date' : 'First due date', type: 'date', required: true, value: b?.next_due_on || localDate() },
      { name: 'recurrence', label: 'Repeats', type: 'select', value: b?.recurrence || 'monthly',
        options: Object.entries(RECUR).map(([value, label]) => ({ value, label })) },
      { name: 'bucket', label: 'Budget bucket', type: 'select', value: b?.bucket || 'needs',
        options: Object.entries(BUCKETS).map(([value, x]) => ({ value, label: `${x.emoji} ${x.label}` })) },
      { name: 'responsible', label: 'Who pays it', type: 'select', value: b?.responsible || '',
        options: [{ value: '', label: 'Either of us' }, { value: me?.id, label: me?.display_name || 'Me' },
          ...(partner ? [{ value: partner.id, label: partner.display_name }] : [])] },
      { name: 'autopay', label: 'On autopay', type: 'checkbox', value: b?.autopay || false }
    ], {
      extra: stop,
      onSubmit: async (v) => {
        if (stopped) return;
        const cents = parseCents(v.amount);
        if (cents == null) throw new Error('Enter an amount');
        const day = Number(v.next.slice(8, 10));
        const row = {
          name: v.name, amount_cents: cents, next_due_on: v.next, recurrence: v.recurrence,
          due_day: v.recurrence === 'monthly' ? day : null, bucket: v.bucket,
          responsible: v.responsible || null, autopay: v.autopay
        };
        unwrap(b ? await supabase.from('bills').update(row).eq('id', b.id) : await supabase.from('bills').insert(row));
        haptic(10);
      }
    });
  }

  dispose(liveReload(['bills', 'bill_payments'], load));
  const timer = setInterval(render, 10 * 60_000);       // due labels roll over at midnight
  dispose(() => clearInterval(timer));
  load();
  return dispose.run;
}
