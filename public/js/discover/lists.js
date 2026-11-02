/* Couples App · Shared lists
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Grocery runs, to-dos and quick notes that both phones edit live. A list
 * shared from Apple Notes (via the iPhone Shortcut) or pasted into the
 * inbox arrives here already split into items, quantities included.
 */
import { toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic } from '../ui.js';
import { burst } from '../fx.js';
import { formSheet, confirmDialog } from '../sheet.js';
import { section, disposer, nameOf } from '../spark/common.js';
import { liveReload } from '../money/common.js';

const KIND_EMOJI = { grocery: '🛒', todo: '✅', budget: '💵', other: '📝' };

export function mount(host) {
  const dispose = disposer();
  const rail = h('div.list-rail', { role: 'tablist', 'aria-label': 'Lists' });
  const body = h('div.list-body');
  const addList = pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, '+ List'));
  addList.addEventListener('click', () => editList());
  host.append(section('lists-card', null,
    h('div.card-head', h('h2.card-title', '📝 Lists'), addList),
    rail, body));

  let lists = [];
  let items = [];
  let currentId = null;
  const pendingFocus = { add: false };

  async function load() {
    try {
      [lists, items] = await Promise.all([
        supabase.from('checklists').select('*').eq('archived', false).order('updated_at', { ascending: false }).then(unwrap),
        supabase.from('checklist_items').select('*').order('position').order('created_at').limit(2000).then(unwrap)
      ]);
    } catch (err) { console.warn('[lists]', err); }
    if (!lists.some((l) => l.id === currentId)) currentId = lists[0]?.id || null;
    render();
  }

  const itemsOf = (id) => items.filter((i) => i.checklist_id === id);

  function render() {
    clear(rail);
    for (const l of lists) {
      const its = itemsOf(l.id);
      const open = its.filter((i) => !i.is_done).length;
      const tab = pressable(h('button.chip' + (l.id === currentId ? '.active' : ''), { type: 'button', role: 'tab', 'aria-selected': String(l.id === currentId) },
        `${KIND_EMOJI[l.kind] || '📝'} ${l.title}`, open ? h('span.chip-badge', String(open)) : null));
      tab.addEventListener('click', () => { currentId = l.id; render(); });
      rail.append(tab);
    }
    clear(body);
    const l = lists.find((x) => x.id === currentId);
    if (!l) {
      body.append(h('p.muted.small', 'No lists yet. Paste a few lines into the inbox above, share a note from Apple Notes, or tap “+ List”.'));
      return;
    }
    const its = itemsOf(l.id);
    const done = its.filter((i) => i.is_done).length;
    const pct = its.length ? Math.round((done / its.length) * 100) : 0;

    const addInput = h('input.input', { placeholder: l.kind === 'grocery' ? 'Add an item (e.g. 2 avocados)' : 'Add an item', maxlength: 300, 'aria-label': 'New item' });
    const addBtn = pressable(h('button.btn.btn-primary.btn-sm', { type: 'button' }, 'Add'));
    const add = async () => {
      const raw = addInput.value.trim();
      if (!raw) return;
      const m = /^(\d+(?:[.,]\d+)?\s*(?:x|lbs?|oz|kg|g|ct|pcs?|packs?|dozen)?)\s+(.+)$/i.exec(raw);
      addBtn.disabled = true;
      try {
        unwrap(await supabase.from('checklist_items').insert({
          checklist_id: l.id, body: (m ? m[2] : raw).slice(0, 300), quantity: m ? m[1] : null,
          position: its.length ? Math.max(...its.map((i) => i.position)) + 1 : 0
        }));
        addInput.value = '';
        pendingFocus.add = true;
        haptic(6);
      } catch (err) { toast(err.message, { tone: 'error' }); }
      finally { addBtn.disabled = false; }
    };
    addBtn.addEventListener('click', add);
    addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

    const menu = pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, 'Edit'));
    menu.addEventListener('click', () => editList(l));
    const clearDone = done ? pressable(h('button.btn.btn-ghost.btn-sm', { type: 'button' }, `Clear ${done} done`)) : null;
    clearDone?.addEventListener('click', async () => {
      const { error } = await supabase.from('checklist_items').delete().eq('checklist_id', l.id).eq('is_done', true);
      if (error) toast(error.message, { tone: 'error' });
    });

    const ul = h('ul.check-list');
    for (const it of [...its].sort((a, b) => Number(a.is_done) - Number(b.is_done) || a.position - b.position)) {
      const box = h('input', { type: 'checkbox', 'aria-label': it.body });
      box.checked = it.is_done;
      box.addEventListener('change', async () => {
        haptic(box.checked ? [6, 20, 6] : 6);
        const { error } = await supabase.from('checklist_items').update({ is_done: box.checked }).eq('id', it.id);
        if (error) { toast(error.message, { tone: 'error' }); box.checked = !box.checked; return; }
        if (box.checked && its.every((x) => x.id === it.id || x.is_done)) {
          burst({ kind: 'match', count: 30 });
          toast(`${l.title}: all done ✨`, { tone: 'ok' });
        }
      });
      const remove = pressable(h('button.icon-btn.check-del', { type: 'button', 'aria-label': `Delete ${it.body}` }, '×'));
      remove.addEventListener('click', async () => {
        const { error } = await supabase.from('checklist_items').delete().eq('id', it.id);
        if (error) toast(error.message, { tone: 'error' });
      });
      ul.append(h('li.check-item' + (it.is_done ? '.done' : ''),
        h('label.check-label', box, h('span.check-box', { 'aria-hidden': 'true' }),
          h('span.check-text', it.quantity ? h('span.check-qty', it.quantity) : null, it.body),
          it.is_done && it.done_by ? h('span.muted.small.check-by', nameOf(it.done_by)) : null),
        remove));
    }

    body.append(
      h('div.list-progress', { style: { '--p': `${pct}%` } },
        h('span.list-progress-bar'),
        h('span.small', its.length ? `${done} of ${its.length} done` : 'Empty list')),
      ul,
      h('div.amount-row', addInput, addBtn),
      h('div.btn-row-tight', clearDone, menu));
    if (pendingFocus.add) { pendingFocus.add = false; addInput.focus({ preventScroll: true }); }
  }

  async function editList(l = null) {
    let removed = false;
    const extra = l ? h('div.btn-row-tight') : null;
    if (l) {
      const archive = pressable(h('button.btn.btn-ghost', { type: 'button' }, 'Archive'));
      archive.addEventListener('click', async () => {
        const { error } = await supabase.from('checklists').update({ archived: true }).eq('id', l.id);
        if (error) toast(error.message, { tone: 'error' });
        else { removed = true; document.querySelector('.sheet-host .sheet-backdrop')?.click(); }
      });
      const del = pressable(h('button.btn.btn-ghost.danger', { type: 'button' }, 'Delete'));
      del.addEventListener('click', async () => {
        if (!(await confirmDialog(`Delete “${l.title}”?`, 'All its items go too.', { confirmLabel: 'Delete', danger: true }))) return;
        const { error } = await supabase.from('checklists').delete().eq('id', l.id);
        if (error) toast(error.message, { tone: 'error' });
        else { removed = true; document.querySelector('.sheet-host .sheet-backdrop')?.click(); }
      });
      extra.append(archive, del);
    }
    await formSheet(l ? 'Edit list' : 'New list', [
      { name: 'title', label: 'Name', required: true, maxlength: 80, value: l?.title || '', placeholder: 'Costco run' },
      { name: 'kind', label: 'Type', type: 'select', value: l?.kind || 'todo', options: [
        { value: 'grocery', label: '🛒 Groceries' }, { value: 'todo', label: '✅ To-do' },
        { value: 'budget', label: '💵 Money' }, { value: 'other', label: '📝 Notes' }] }
    ], {
      extra,
      submitLabel: l ? 'Save' : 'Create',
      onSubmit: async (v) => {
        if (removed) return;
        if (l) unwrap(await supabase.from('checklists').update({ title: v.title, kind: v.kind }).eq('id', l.id));
        else {
          const row = unwrap(await supabase.from('checklists').insert({ title: v.title, kind: v.kind }).select('id').single());
          currentId = row.id;
        }
      }
    });
  }

  const onFiled = (e) => {
    if (e.detail?.table === 'checklists') { currentId = e.detail.id; load(); }
  };
  window.addEventListener('us:inbox-filed', onFiled);
  dispose(() => window.removeEventListener('us:inbox-filed', onFiled));

  dispose(liveReload(['checklists', 'checklist_items'], load));
  load();
  return dispose.run;
}
