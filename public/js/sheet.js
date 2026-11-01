/* Couples App · reusable bottom sheets, forms and dialogs
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 */
import { h, icon, pressable } from './ui.js';
import { burst } from './fx.js';

/** Opens a glass bottom sheet. Returns { body, close }. onClose fires once. */
export function openSheet(title, { onClose } = {}) {
  const body = h('div.sheet-body');
  const closeBtn = pressable(h('button.icon-btn', { type: 'button', 'aria-label': 'Close' }, icon('close', { size: 22 })));
  const sheet = h('section.sheet.glass', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.sheet-grabber', { 'aria-hidden': 'true' }),
    h('header.sheet-header', h('h2.title-lg', title), closeBtn),
    body);
  const backdrop = h('div.sheet-backdrop');
  const host = h('div.sheet-host', backdrop, sheet);
  document.body.append(host);
  requestAnimationFrame(() => host.classList.add('open'));

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    host.classList.remove('open');
    setTimeout(() => host.remove(), 380);
    onClose?.();
  };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  swipeToClose(sheet, close);
  return { body, close, sheet };
}

function swipeToClose(sheet, close) {
  let startY = 0;
  let dy = 0;
  let dragging = false;
  for (const el of [sheet.querySelector('.sheet-grabber'), sheet.querySelector('.sheet-header')]) {
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; startY = e.clientY; dy = 0;
      sheet.style.transition = 'none';
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dy = Math.max(0, e.clientY - startY);
      sheet.style.transform = `translate3d(0, ${dy}px, 0)`;
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy > 110) close();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}

/**
 * Form in a sheet. fields: [{ name, label, type, value, options, required, maxlength, min, max, placeholder }]
 * Resolves with an object of values, or null when dismissed.
 * onSubmit(values) may throw to show an error and keep the sheet open.
 */
export function formSheet(title, fields, { submitLabel = 'Save', onSubmit, extra } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const { body, close } = openSheet(title, { onClose: () => { if (!settled) { settled = true; resolve(null); } } });
    const inputs = {};
    const form = h('form.form-grid', { novalidate: true });

    for (const f of fields) {
      let input;
      if (f.type === 'select') {
        input = h('select.input', { name: f.name }, f.options.map((o) =>
          h('option', { value: o.value }, o.label)));
        input.value = f.value ?? f.options[0]?.value;
      } else if (f.type === 'textarea') {
        input = h('textarea.input.textarea', { name: f.name, maxlength: f.maxlength, placeholder: f.placeholder, rows: f.rows || 3 });
        input.value = f.value ?? '';
      } else if (f.type === 'checkbox') {
        input = h('input', { type: 'checkbox', name: f.name, role: 'switch' });
        input.checked = Boolean(f.value);
        form.append(h('div.settings-row', h('span', f.label),
          h('label.switch', input, h('span.switch-track', h('span.switch-thumb')))));
        inputs[f.name] = input;
        continue;
      } else {
        input = h('input.input', {
          name: f.name, type: f.type || 'text', maxlength: f.maxlength, min: f.min, max: f.max, step: f.step,
          placeholder: f.placeholder, inputmode: f.inputmode, autocomplete: 'off'
        });
        input.value = f.value ?? '';
      }
      inputs[f.name] = input;
      form.append(h('label.field', h('span.field-label', f.label), input, f.hint ? h('span.muted.small', f.hint) : null));
    }

    const error = h('p.form-error', { role: 'alert' });
    const submit = pressable(h('button.btn.btn-primary.btn-block', { type: 'submit' }, submitLabel));
    if (extra) form.append(extra);
    form.append(error, submit);
    body.append(form);
    setTimeout(() => form.querySelector('input:not([type=checkbox]), textarea')?.focus({ preventScroll: true }), 420);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const values = {};
      for (const f of fields) {
        const el = inputs[f.name];
        let v = f.type === 'checkbox' ? el.checked : el.value.trim();
        if (f.required && v === '') { error.textContent = `${f.label} is required`; el.focus(); return; }
        if (f.type === 'number' && v !== '') v = Number(v);
        values[f.name] = v;
      }
      submit.disabled = true;
      try {
        if (onSubmit) await onSubmit(values);
        settled = true;
        resolve(values);
        close();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    });
  });
}

/** Centered celebration / confirm modal with optional actions. */
export function celebrate({ emoji = '💞', title, body, actions = [], kind = 'match' }) {
  const backdrop = h('div.modal-backdrop');
  const close = () => {
    backdrop.classList.add('closing');
    setTimeout(() => backdrop.remove(), 260);
  };
  const buttons = actions.map((a) => {
    const b = pressable(h(`button.btn.${a.primary ? 'btn-primary' : 'btn-ghost'}.btn-block`, { type: 'button' }, a.label));
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await a.onClick?.(); } finally { close(); }
    });
    return b;
  });
  const dismiss = pressable(h('button.btn.btn-ghost.btn-block', { type: 'button' }, actions.length ? 'Not now' : 'Close'));
  dismiss.addEventListener('click', close);
  backdrop.append(h('div.modal.glass.celebrate', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.celebrate-emoji', { 'aria-hidden': 'true' }, emoji),
    h('h2.title-lg', title),
    body ? h('p.muted', body) : null,
    ...buttons, dismiss));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  burst({ kind });
  return close;
}

export function confirmDialog(title, body, { confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const backdrop = h('div.modal-backdrop');
    const done = (v) => { backdrop.remove(); resolve(v); };
    const ok = pressable(h(`button.btn.btn-block.${danger ? 'btn-ghost.danger' : 'btn-primary'}`, { type: 'button' }, confirmLabel));
    const cancel = pressable(h('button.btn.btn-ghost.btn-block', { type: 'button' }, 'Cancel'));
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
    backdrop.append(h('div.modal.glass', { role: 'dialog', 'aria-modal': 'true' },
      h('h2.title-lg', title), body ? h('p.muted', body) : null, ok, cancel));
    document.body.append(backdrop);
  });
}
