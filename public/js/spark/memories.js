/* Couples App · Polaroid memory calendar
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * One photo each per day (enforced by a unique constraint). Together they
 * form the day's dual polaroid; the month grid shows every day you kept.
 */
import { store, toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, icon, pressable, clear, haptic } from '../ui.js';
import { tilt } from '../fx.js';
import { onTable, onResync } from '../realtime.js';
import { compressImage, uploadTo, signedUrls } from '../media.js';
import { formSheet, openSheet, confirmDialog } from '../sheet.js';
import { myId, nameOf, partnerName, localDate, section, disposer } from './common.js';

const BUCKET = 'memories';

export function mount(host) {
  const dispose = disposer();
  const today = h('div.polaroid-pair');
  const cal = h('div.mem-calendar');
  host.append(section('memories-card', 'Today’s polaroids', today, cal));

  let cursor = new Date();
  cursor.setDate(1);
  let rows = [];            // memories in visible month (+ today)
  let urls = {};

  const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
  host.append(file);
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (f) await addPhoto(f);
  });

  function monthRange() {
    const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    return [localDate(start), localDate(end)];
  }

  async function load() {
    const [from, to] = monthRange();
    const t = localDate();
    try {
      rows = unwrap(await supabase.from('memories').select('*')
        .or(`and(for_date.gte.${from},for_date.lte.${to}),for_date.eq.${t}`)
        .order('for_date'));
      urls = await signedUrls(BUCKET, rows.map((r) => r.storage_path));
    } catch (err) { console.warn('[memories]', err); }
    render();
  }

  function polaroid(row, who, { placeholder, onAdd } = {}) {
    const p = who === 'me' ? store.get().me : store.get().partner;
    if (!row) {
      const el = h('div.polaroid.empty', { style: { '--accent': p?.accent || '#ff2d78' } },
        h('div.polaroid-photo', placeholder ? h('span.muted.small', placeholder) : null),
        h('div.polaroid-caption', p?.display_name || (who === 'me' ? 'You' : partnerName())));
      if (onAdd) {
        const add = pressable(h('button.polaroid-add', { type: 'button', 'aria-label': 'Add today’s photo' }, icon('image', { size: 26 }), h('span', 'Add today’s photo')));
        add.addEventListener('click', onAdd);
        el.querySelector('.polaroid-photo').append(add);
      }
      return el;
    }
    const img = h('img', { src: urls[row.storage_path] || '', alt: row.caption || `Photo by ${nameOf(row.created_by)}`, loading: 'lazy', decoding: 'async' });
    return tilt(h('figure.polaroid', { style: { '--accent': p?.accent || '#ff2d78' } },
      h('div.polaroid-photo', img),
      h('figcaption.polaroid-caption', row.caption || p?.display_name || '')), { max: 12 });
  }

  function render() {
    const t = localDate();
    const mine = rows.find((r) => r.for_date === t && r.created_by === myId());
    const theirs = rows.find((r) => r.for_date === t && r.created_by !== myId());
    clear(today).append(
      polaroid(mine, 'me', { onAdd: () => file.click() }),
      polaroid(theirs, 'partner', { placeholder: `Waiting for ${partnerName()}` })
    );
    if (mine) {
      const replace = h('button.link.small', { type: 'button' }, 'Replace my photo');
      replace.addEventListener('click', () => file.click());
      today.append(replace);
    }
    renderCalendar();
  }

  function renderCalendar() {
    clear(cal);
    const prev = pressable(h('button.icon-btn', { type: 'button', 'aria-label': 'Previous month' }, icon('back', { size: 18 })));
    const next = pressable(h('button.icon-btn.flip', { type: 'button', 'aria-label': 'Next month' }, icon('back', { size: 18 })));
    prev.addEventListener('click', () => { cursor.setMonth(cursor.getMonth() - 1); load(); });
    next.addEventListener('click', () => { cursor.setMonth(cursor.getMonth() + 1); load(); });
    const now = new Date();
    next.disabled = cursor.getFullYear() === now.getFullYear() && cursor.getMonth() >= now.getMonth();

    cal.append(h('div.cal-head', prev,
      h('strong', cursor.toLocaleDateString([], { month: 'long', year: 'numeric' })), next));

    const grid = h('div.cal-grid');
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((d) => grid.append(h('span.cal-dow', d)));
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    for (let i = 0; i < first.getDay(); i++) grid.append(h('span'));
    const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const todayStr = localDate();
    for (let d = 1; d <= days; d++) {
      const date = localDate(new Date(cursor.getFullYear(), cursor.getMonth(), d));
      const dayRows = rows.filter((r) => r.for_date === date);
      const cell = h('button.cal-day' + (date === todayStr ? '.today' : '') + (dayRows.length === 2 ? '.both' : ''),
        { type: 'button', 'aria-label': `${date}${dayRows.length ? `, ${dayRows.length} photo${dayRows.length > 1 ? 's' : ''}` : ''}` },
        h('span.cal-num', String(d)));
      if (dayRows[0] && urls[dayRows[0].storage_path]) {
        cell.style.backgroundImage = `url("${urls[dayRows[0].storage_path].replace(/"/g, '%22')}")`;
        cell.classList.add('has-photo');
      }
      if (dayRows.length) cell.addEventListener('click', () => openDay(date, dayRows));
      else cell.disabled = true;
      grid.append(cell);
    }
    cal.append(grid);
  }

  function openDay(date, dayRows) {
    const { body } = openSheet(new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
    const mine = dayRows.find((r) => r.created_by === myId());
    const theirs = dayRows.find((r) => r.created_by !== myId());
    body.append(h('div.polaroid-pair.large',
      polaroid(mine, 'me', { placeholder: 'No photo' }),
      polaroid(theirs, 'partner', { placeholder: 'No photo' })));
  }

  async function addPhoto(f) {
    const vals = await formSheet('Caption it', [
      { name: 'caption', label: 'Caption (optional)', maxlength: 280, placeholder: 'What made today?' }
    ], { submitLabel: 'Pin polaroid' });
    if (!vals) return;
    const t = localDate();
    const existing = rows.find((r) => r.for_date === t && r.created_by === myId());
    if (existing && !(await confirmDialog('Replace today’s photo?', 'Your earlier photo for today will be deleted.', { confirmLabel: 'Replace' }))) return;
    try {
      toast('Developing your polaroid…');
      const blob = await compressImage(f, { maxEdge: 1600, quality: 0.85 });
      const path = await uploadTo(BUCKET, `${t}-${Date.now()}.jpg`, blob, 'image/jpeg');
      if (existing) {
        unwrap(await supabase.from('memories').delete().eq('id', existing.id));
        supabase.storage.from(BUCKET).remove([existing.storage_path]).catch(() => {});
      }
      unwrap(await supabase.from('memories').insert({ for_date: t, storage_path: path, caption: vals.caption || null }));
      haptic([10, 30, 10]);
      await load();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  }

  dispose(onTable('memories', (row, _o, type) => {
    if (type === 'INSERT' && row.created_by !== myId()) toast(`📸 ${nameOf(row.created_by)} added today’s polaroid`, { tone: 'love' });
    load();
  }));
  dispose(onResync(load));

  load();
  return dispose.run;
}
