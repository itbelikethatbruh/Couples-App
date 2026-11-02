/* Couples App · Discover (Module 6)
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * The shared inbox (paste or share anything and it files itself), the
 * TikTok vault, shared lists, and the iPhone Shortcut + home-screen widget
 * setup. Nothing here needs a third-party API key.
 */
import { h, isIOS } from '../ui.js';
import * as inboxMod from '../discover/inbox.js';
import * as tiktokMod from '../discover/tiktok.js';
import * as listsMod from '../discover/lists.js';
import * as connectMod from '../discover/connect.js';

export function mount(page) {
  page.append(h('header.page-header',
    h('p.eyebrow', 'Share it once, find it together'),
    h('h1.title-xl', 'Discover')));
  const modules = h('div.discover-modules');
  page.append(modules);

  const cleanups = [];
  // On iPhone the Share Sheet setup matters most, so it sits right under the inbox.
  const order = isIOS() ? [inboxMod, connectMod, tiktokMod, listsMod] : [inboxMod, tiktokMod, listsMod, connectMod];
  for (const mod of order) {
    const slot = h('div.discover-slot');
    modules.append(slot);
    try { cleanups.push(mod.mount(slot)); } catch (err) { console.error('[discover] module failed', err); }
  }
  return () => cleanups.forEach((fn) => { try { fn?.(); } catch { /* ignore */ } });
}
