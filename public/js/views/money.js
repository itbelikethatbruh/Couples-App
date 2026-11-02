/* Couples App · Money (Module 3)
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Settle-up balance, 50/30/20 budget rings, recurring bills, a spending
 * log, and savings jars. Every card listens to
 * realtime changes, so a bill paid on one phone flips on the other.
 */
import { h } from '../ui.js';
import * as settleMod from '../money/settle.js';
import * as budgetMod from '../money/budget.js';
import * as billsMod from '../money/bills.js';
import * as spendingMod from '../money/spending.js';
import * as fundsMod from '../money/funds.js';
import { monthRange } from '../money/common.js';

export function mount(page) {
  page.append(h('header.page-header',
    h('p.eyebrow', monthRange().label),
    h('h1.title-xl', 'Money')));
  const modules = h('div.money-modules');
  page.append(modules);

  const cleanups = [];
  for (const mod of [settleMod, budgetMod, billsMod, spendingMod, fundsMod]) {
    const slot = h('div.money-slot');
    modules.append(slot);
    try { cleanups.push(mod.mount(slot)); } catch (err) { console.error('[money] module failed', err); }
  }
  return () => cleanups.forEach((fn) => { try { fn?.(); } catch { /* ignore */ } });
}
