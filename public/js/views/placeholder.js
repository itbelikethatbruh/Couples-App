/* Couples App · module placeholder (replaced phase by phase)
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 */
import { h } from '../ui.js';
import { tilt } from '../fx.js';

const PLANS = {
  discover: {
    title: 'Discover',
    phase: 'Phase 4',
    blurb: 'TikToks to watch together and a shared notes inbox.',
    items: ['Inline TikTok vault', 'Share Sheet inbox', 'Shared notes']
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
