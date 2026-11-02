/* Couples App · iPhone setup: Share Sheet Shortcut + home-screen widget
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * iPhones can't add web apps to the Share Sheet, so an Apple Shortcut does
 * it: share a TikTok, a link or an Apple Note → "Send to Us" → it lands in
 * the right place on both phones. The same private token powers a
 * Scriptable home-screen widget. Tokens are shown once, stored only as a
 * hash, and can be revoked here.
 */
import { CONFIG } from '../config.js';
import { toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic, timeAgo, isIOS } from '../ui.js';
import { openSheet, confirmDialog } from '../sheet.js';
import { section, disposer } from '../spark/common.js';
import { liveReload } from '../money/common.js';

const INBOX_URL = `${CONFIG.SUPABASE_URL}/functions/v1/universal-inbox`;

async function copy(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    haptic(8);
    toast(done, { tone: 'ok' });
    return true;
  } catch {
    toast('Copy blocked. Long-press the text to copy it.', { tone: 'error' });
    return false;
  }
}

function copyRow(label, value, { secret = false } = {}) {
  const field = h('code.copy-value' + (secret ? '.secret' : ''), value);
  const btn = pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, 'Copy'));
  btn.addEventListener('click', () => copy(value, `${label} copied`));
  return h('div.copy-row', h('span.field-label', label), h('div.copy-line', field, btn));
}

async function widgetScript(token) {
  const res = await fetch('/scriptable/us-widget.js', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load the widget script');
  const tpl = await res.text();
  return tpl
    .replace('__SUPABASE_URL__', CONFIG.SUPABASE_URL)
    .replace('__ANON_KEY__', CONFIG.SUPABASE_ANON_KEY)
    .replace('__TOKEN__', token)
    .replace('__APP_URL__', `${location.origin}/#/discover`);
}

export function mount(host) {
  const dispose = disposer();
  const list = h('div.token-list');
  const setup = pressable(h('button.btn.btn-primary', { type: 'button' }, isIOS() ? 'Set up this iPhone' : 'Set up an iPhone'));
  setup.addEventListener('click', () => createToken());
  host.append(section('connect-card', null,
    h('div.card-head', h('h2.card-title', '📲 iPhone Share Sheet & widget')),
    h('p.muted.small', 'Adds “Send to Us” to the iPhone Share Sheet (TikTok, Safari, Amazon, Apple Notes) and a home-screen widget. Android already has “Us” in its share menu once the app is installed.'),
    h('div.btn-row', setup),
    list));

  async function load() {
    let rows = [];
    try {
      rows = await supabase.from('inbox_tokens').select('id,label,created_at,last_used_at,revoked_at')
        .is('revoked_at', null).order('created_at', { ascending: false }).then(unwrap);
    } catch (err) { console.warn('[connect]', err); }
    clear(list);
    if (!rows.length) return;
    list.append(h('p.eyebrow.small', 'Your connected devices'));
    for (const t of rows) {
      const revoke = pressable(h('button.btn.btn-ghost.btn-sm.danger', { type: 'button' }, 'Revoke'));
      revoke.addEventListener('click', async () => {
        if (!(await confirmDialog(`Revoke “${t.label}”?`, 'The Shortcut and widget using it stop working right away.', { confirmLabel: 'Revoke', danger: true }))) return;
        const { error } = await supabase.from('inbox_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', t.id);
        if (error) toast(error.message, { tone: 'error' }); else load();
      });
      list.append(h('div.token-row',
        h('div', h('strong', t.label), h('span.muted.small', t.last_used_at ? ` · used ${timeAgo(t.last_used_at)}` : ' · not used yet')),
        revoke));
    }
  }

  async function createToken() {
    let token;
    try {
      token = unwrap(await supabase.rpc('create_inbox_token', { p_label: isIOS() ? 'This iPhone' : 'iPhone' }));
    } catch (err) { toast(err.message, { tone: 'error' }); return; }
    load();

    const { body } = openSheet('Set up “Send to Us”');
    const widgetBtn = pressable(h('button.btn.btn-glass.btn-block', { type: 'button' }, '📋 Copy widget script'));
    widgetBtn.addEventListener('click', async () => {
      try { await copy(await widgetScript(token), 'Widget script copied'); }
      catch (err) { toast(err.message, { tone: 'error' }); }
    });

    body.append(
      h('p.small.warn-note', '🔒 This token is shown only once. It acts as you, so keep it private. You can revoke it from the Discover tab.'),
      copyRow('Token', token, { secret: true }),
      copyRow('Address', INBOX_URL),
      h('h3.title-md', '1 · The Shortcut (2 minutes)'),
      h('p.small.muted', 'iPhones don’t let web apps appear in the Share Sheet, so a Shortcut does it. Do this on the iPhone:'),
      h('ol.steps',
        h('li', 'Open the ', h('strong', 'Shortcuts'), ' app → tap ', h('strong', '+'), ' (top right). Tap the name at the top → ', h('strong', 'Rename'), ' → ', h('strong', 'Send to Us'), '.'),
        h('li', 'Tap the ', h('strong', 'ⓘ'), ' button at the bottom → turn on ', h('strong', 'Show in Share Sheet'), ' → ', h('strong', 'Done'), '.'),
        h('li', 'A block appears at the top: “Receive ', h('em', '…'), ' input from Share Sheet”. Tap the blue types and select ', h('strong', 'everything'), ' (at least URLs, Text and Safari web pages).'),
        h('li', 'Search for the action ', h('strong', 'Get Contents of URL'), ' and add it. Tap the blue ', h('strong', 'URL'), ' and paste the ', h('strong', 'Address'), ' above.'),
        h('li', 'Tap the ', h('strong', '›'), ' arrow on that action: Method ', h('strong', 'POST'), '. Headers → ', h('strong', 'Add new header'), ': key ', h('code', 'X-Inbox-Token'), ', value = the ', h('strong', 'Token'), ' above.'),
        h('li', 'Request Body ', h('strong', 'JSON'), ' → ', h('strong', 'Add new field'), ' → Text: key ', h('code', 'text'), ', value: tap and pick ', h('strong', 'Shortcut Input'), '.'),
        h('li', 'Add ', h('strong', 'Get Dictionary Value'), ' (Key: ', h('code', 'message'), '), then ', h('strong', 'Show Notification'), ' with that value. Tap ', h('strong', 'Done'), '.'),
        h('li', 'In TikTok: tap ', h('strong', 'Share'), ' → swipe the bottom row to ', h('strong', 'More'), ' (…) → scroll down the list → ', h('strong', 'Send to Us'), '. Not there? Scroll to the bottom, tap ', h('strong', 'Edit Actions'), ' and turn it on.')),
      h('p.small.muted', 'No Shortcut? In TikTok tap Share → Copy link, then open Us → Discover → 📋 Paste. Same result.'),
      h('h3.title-md', '2 · The home-screen widget'),
      h('ol.steps',
        h('li', 'Install ', h('strong', 'Scriptable'), ' (free) from the App Store.'),
        h('li', 'Tap the button below, then in Scriptable tap ', h('strong', '+'), ', paste, and name it ', h('strong', 'Us'), '.'),
        h('li', 'Long-press your Home Screen → ', h('strong', '+'), ' → Scriptable → add a widget → tap it → Script: ', h('strong', 'Us'), '.')),
      widgetBtn,
      h('p.muted.small', 'The widget shows your next countdown, new TikToks, open to-dos and bills due this week, and opens the app when tapped.'));
  }

  dispose(liveReload(['inbox_tokens'], load));
  load();
  return dispose.run;
}
