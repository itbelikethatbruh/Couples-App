/* Couples App · module placeholder (replaced phase by phase)
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 */
import { h } from '../ui.js';
import { tilt } from '../fx.js';

const PLANS = {
  vault: {
    title: 'Vault',
    phase: 'Phase 2',
    blurb: "Each other's sizes, orders, favorites, dietary rules and countdowns.",
    items: ['Ring, shoe, shirt & pants sizes', 'Coffee and fast-food orders', 'Scents, brands & snacks', 'Allergies and dietary rules', 'Seat preferences', 'Birthday, anniversary & trip countdowns']
  },
  money: {
    title: 'Money',
    phase: 'Phase 3',
    blurb: 'Bills, budgets and a settle-up ledger that does the math.',
    items: ['Recurring bill calendar', '50/30/20 budget rings', 'Sinking funds', 'AI receipt scanner', 'Settle-up balance']
  },
  wishlist: {
    title: 'Wishlists',
    phase: 'Phase 3',
    blurb: 'Paste any link. Surprise Lock keeps secret gifts secret.',
    items: ['Personal Amazon boards', 'Restaurants, vacations & events', 'Auto title, photo & price', 'Priority tags', 'Surprise Lock']
  },
  discover: {
    title: 'Discover',
    phase: 'Phase 4',
    blurb: 'Events near home, TikToks to watch together, and a smart notes inbox.',
    items: ['Ticketmaster events', 'Inline TikTok vault', 'AI wishlist chips', 'Share Sheet inbox', 'AI notes organizer']
  }
};

export function mount(page, { tab }) {
  const plan = PLANS[tab.id];
  page.append(
    h('header.page-header', h('p.eyebrow', plan.phase), h('h1.title-xl', plan.title)),
    tilt(h('section.glass.card.placeholder-card',
      h('div.card-sheen', { 'aria-hidden': 'true' }),
      h('div.placeholder-orb', { 'aria-hidden': 'true' }),
      h('p.lead', plan.blurb),
      h('ul.roadmap-list', plan.items.map((t) => h('li', t))),
      h('p.muted.small', 'The database tables for this module already exist, so nothing needs migrating later.')
    ))
  );
}
