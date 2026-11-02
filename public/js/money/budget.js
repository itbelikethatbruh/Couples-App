/* Couples App · 50/30/20 budget rings
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Three concentric rings (needs / wants / savings) fill as the month's
 * spending lands in each bucket. Targets come from monthly take-home pay
 * × each bucket's percentage. Over budget, a ring keeps going and glows red.
 */
import { toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic } from '../ui.js';
import { tilt } from '../fx.js';
import { formSheet } from '../sheet.js';
import { section, disposer, localDate } from '../spark/common.js';
import { fmt, parseCents, centsToInput, monthRange, BUCKETS, liveReload } from './common.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

export function mount(host) {
  const dispose = disposer();
  const body = h('div.budget-body');
  host.append(tilt(section('budget-card', null, body), { max: 5 }));

  let settings = null;
  let spent = { needs: 0, wants: 0, savings: 0 };
  let offset = 0;                       // 0 = this month, -1 = last month …

  const monthDate = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + offset, 1); };

  async function load() {
    try {
      const [rows, s] = await Promise.all([
        supabase.rpc('budget_month', { p_month: localDate(monthDate()) }).then(unwrap),
        supabase.from('budget_settings').select('*').maybeSingle().then(unwrap)
      ]);
      settings = s;
      spent = { needs: 0, wants: 0, savings: 0 };
      for (const r of rows || []) spent[r.bucket] = Number(r.spent_cents) || 0;
    } catch (err) { console.warn('[budget]', err); }
    render();
  }

  function rings(targets) {
    const size = 180;
    const c = size / 2;
    const el = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'rings-svg', role: 'img', 'aria-label': 'Budget rings' });
    const defs = svg('defs');
    el.append(defs);
    Object.entries(BUCKETS).forEach(([key, b], i) => {
      const r = 76 - i * 17;
      const circ = 2 * Math.PI * r;
      const target = targets[key];
      const ratio = target > 0 ? spent[key] / target : (spent[key] > 0 ? 1 : 0);
      const shown = Math.min(ratio, 1);
      const grad = svg('linearGradient', { id: `ring-${key}`, x1: '0', y1: '0', x2: '1', y2: '1' });
      grad.append(svg('stop', { offset: '0%', 'stop-color': b.color }), svg('stop', { offset: '100%', 'stop-color': ratio > 1 ? '#ff5a6e' : '#ffffff', 'stop-opacity': ratio > 1 ? 1 : 0.85 }));
      defs.append(grad);
      el.append(svg('circle', { cx: c, cy: c, r, class: 'ring-track' }));
      const arc = svg('circle', {
        cx: c, cy: c, r, class: 'ring-arc' + (ratio > 1 ? ' over' : ''), stroke: `url(#ring-${key})`,
        'stroke-dasharray': circ, 'stroke-dashoffset': circ, transform: `rotate(-90 ${c} ${c})`, style: `--glow:${b.color}`
      });
      el.append(arc);
      // Animate on the next frame so the ring sweeps in.
      requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', String(circ * (1 - shown)))));
    });
    return el;
  }

  function render() {
    const income = Number(settings?.monthly_income_cents) || 0;
    const pct = { needs: settings?.needs_pct ?? 50, wants: settings?.wants_pct ?? 30, savings: settings?.savings_pct ?? 20 };
    const targets = Object.fromEntries(Object.keys(BUCKETS).map((k) => [k, Math.round(income * pct[k] / 100)]));
    const total = spent.needs + spent.wants + spent.savings;
    const { label } = monthRange(monthDate());

    const prev = pressable(h('button.icon-btn', { type: 'button', 'aria-label': 'Previous month' }, '‹'));
    const next = pressable(h('button.icon-btn', { type: 'button', 'aria-label': 'Next month', disabled: offset >= 0 }, '›'));
    prev.addEventListener('click', () => { offset -= 1; load(); });
    next.addEventListener('click', () => { if (offset < 0) { offset += 1; load(); } });
    const edit = pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, income ? 'Edit' : 'Set income'));
    edit.addEventListener('click', editSettings);

    const legend = h('div.ring-legend', Object.entries(BUCKETS).map(([k, b]) => {
      const t = targets[k];
      const left = t - spent[k];
      return h('div.ring-row', { style: { '--c': b.color } },
        h('span.ring-dot'),
        h('div.ring-text',
          h('strong', `${b.emoji} ${b.label} · ${pct[k]}%`),
          h('span.muted.small', income
            ? `${fmt(spent[k])} of ${fmt(t, { whole: true })} · ${left >= 0 ? `${fmt(left, { whole: true })} left` : `${fmt(-left, { whole: true })} over`}`
            : `${fmt(spent[k])} spent`)));
    }));

    clear(body).append(
      h('div.card-head',
        h('div.month-nav', prev, h('h2.card-title', label), next),
        edit),
      h('div.rings-wrap',
        h('div.rings-3d', rings(targets)),
        h('div.rings-center',
          h('strong.rings-total', fmt(total, { whole: true })),
          h('span.muted.small', income ? `of ${fmt(income, { whole: true })}` : 'spent'))),
      legend);
    if (!income) body.append(h('p.muted.small', 'Add your combined monthly take-home pay to see how much is left in each bucket.'));
  }

  async function editSettings() {
    await formSheet('Monthly budget', [
      { name: 'income', label: 'Combined take-home pay per month ($)', inputmode: 'decimal', required: true,
        value: centsToInput(settings?.monthly_income_cents || null), placeholder: '6500' },
      { name: 'needs', label: 'Needs % (rent, bills, groceries)', type: 'number', min: 0, max: 100, value: settings?.needs_pct ?? 50 },
      { name: 'wants', label: 'Wants % (dining, fun, shopping)', type: 'number', min: 0, max: 100, value: settings?.wants_pct ?? 30 },
      { name: 'savings', label: 'Savings %', type: 'number', min: 0, max: 100, value: settings?.savings_pct ?? 20 }
    ], {
      onSubmit: async (v) => {
        const income = parseCents(v.income);
        if (income == null) throw new Error('Enter your monthly take-home pay');
        const n = Math.round(Number(v.needs)), w = Math.round(Number(v.wants)), s = Math.round(Number(v.savings));
        if ([n, w, s].some((x) => !Number.isFinite(x) || x < 0 || x > 100)) throw new Error('Percentages must be between 0 and 100');
        if (n + w + s !== 100) throw new Error(`The three percentages add up to ${n + w + s}%. Make them total 100%.`);
        const row = { monthly_income_cents: income, needs_pct: n, wants_pct: w, savings_pct: s };
        unwrap(settings
          ? await supabase.from('budget_settings').update(row).eq('couple_id', settings.couple_id)
          : await supabase.from('budget_settings').insert(row));
        haptic(10);
        toast('Budget saved', { tone: 'ok' });
      }
    });
  }

  dispose(liveReload(['budget_settings', 'expenses', 'bill_payments', 'bills'], load));
  load();
  return dispose.run;
}
