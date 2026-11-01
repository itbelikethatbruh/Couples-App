/* Couples App · settings sheet
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Sections: Profile · Wallpaper engine · Lock · Notifications · Motion · Space
 */
import { store, selectors, toast } from '../store.js';
import { supabase } from '../supabase.js';
import { h, icon, pressable, clear, isIOS, isStandalone } from '../ui.js';
import { SCOPES, uploadWallpaper, setAdjustments, resetScope } from '../wallpaper.js';
import {
  biometricAvailable, biometricLabel, enrollBiometric, disableBiometric,
  hasBiometric, hasPin, promptNewPin, clearLockSecrets, lockNow
} from '../lock.js';
import { enablePush, disablePush, pushSupport, pushPermission } from '../push.js';
import { requestMotionPermission, motionNeedsPermission } from '../fx.js';
import { signOut } from '../auth.js';

const SCOPE_LABELS = {
  global: 'Everywhere', lock: 'Lock screen', spark: 'Spark', vault: 'Vault',
  money: 'Money', wishlist: 'Wishlist', discover: 'Discover'
};
const ACCENTS = ['#ff2d78', '#7a5cff', '#3d8bff', '#00c2a8', '#ffb547', '#ff5e3a'];
const AVATARS = ['✨', '🌙', '🔥', '🌹', '🦋', '👑', '🍯', '🎧', '🌊', '🐻'];

let sheetEl = null;

export function openSettings() {
  if (sheetEl) return;
  store.set({ ui: { sheet: 'settings' } });

  const body = h('div.sheet-body');
  const closeBtn = pressable(h('button.icon-btn', { type: 'button', 'aria-label': 'Close settings' }, icon('close', { size: 22 })));
  const sheet = h('section.sheet.glass', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
    h('div.sheet-grabber', { 'aria-hidden': 'true' }),
    h('header.sheet-header', h('h2.title-lg', 'Settings'), closeBtn),
    body);
  const backdrop = h('div.sheet-backdrop');
  sheetEl = h('div.sheet-host', backdrop, sheet);
  document.body.append(sheetEl);
  requestAnimationFrame(() => sheetEl.classList.add('open'));

  const close = () => {
    if (!sheetEl) return;
    const el = sheetEl;
    sheetEl = null;
    el.classList.remove('open');
    setTimeout(() => el.remove(), 380);
    store.set({ ui: { sheet: null } });
    unsubs.forEach((u) => u());
  };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  enableSwipeToClose(sheet, close);

  const unsubs = [];
  body.append(
    profileSection(unsubs),
    wallpaperSection(unsubs),
    lockSection(),
    pushSection(),
    motionSection(),
    spaceSection()
  );
}

function section(title, ...children) {
  return h('section.settings-section', h('h3.section-title', title), ...children);
}

function row(label, control, hint) {
  return h('div.settings-row', h('div.settings-label', h('span', label), hint ? h('span.muted.small', hint) : null), control);
}

function toggle(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label });
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('label.switch', input, h('span.switch-track', h('span.switch-thumb')));
}

// ---------------------------------------------------------------------------
function profileSection(unsubs) {
  const me = store.get().me;
  const name = h('input.input', { type: 'text', maxlength: 32, value: me?.display_name || '', 'aria-label': 'Display name' });
  let t = 0;
  name.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => saveProfile({ display_name: name.value.trim() || 'Partner' }), 500);
  });

  const avatars = h('div.swatch-row', AVATARS.map((a) => {
    const b = pressable(h('button.swatch.emoji', { type: 'button', 'aria-label': `Avatar ${a}` }, a));
    b.addEventListener('click', () => saveProfile({ avatar_emoji: a }));
    return b;
  }));
  const accents = h('div.swatch-row', ACCENTS.map((c) => {
    const b = pressable(h('button.swatch', { type: 'button', 'aria-label': `Accent ${c}`, style: { background: c } }));
    b.addEventListener('click', () => saveProfile({ accent: c }));
    return b;
  }));
  unsubs.push(store.select((s) => [s.me?.avatar_emoji, s.me?.accent], ([a, c]) => {
    [...avatars.children].forEach((b) => b.classList.toggle('selected', b.textContent === a));
    [...accents.children].forEach((b, i) => b.classList.toggle('selected', ACCENTS[i] === c));
  }));

  return section('Profile',
    h('label.field', h('span.field-label', 'Display name'), name),
    h('span.field-label', 'Avatar'), avatars,
    h('span.field-label', 'Accent'), accents);
}

async function saveProfile(patch) {
  const me = store.get().me;
  store.replace('me', { ...me, ...patch });
  const { error } = await supabase.from('profiles').update(patch).eq('id', me.id);
  if (error) { store.replace('me', me); toast(error.message, { tone: 'error' }); }
}

// ---------------------------------------------------------------------------
function wallpaperSection(unsubs) {
  let scope = store.get().ui.tab || 'global';
  if (!SCOPES.includes(scope)) scope = 'global';

  const scopeSelect = h('select.input', { 'aria-label': 'Apply wallpaper to' },
    SCOPES.map((s) => h('option', { value: s }, SCOPE_LABELS[s])));
  scopeSelect.value = scope;

  const preview = h('div.wp-preview', { 'aria-hidden': 'true' }, h('div.wp-preview-img'), h('div.wp-preview-tint'),
    h('div.wp-preview-card.glass', h('strong', 'Legible?'), h('span', 'Text over your photo')));

  const tint = h('input.range', { type: 'range', min: 0, max: 95, step: 1, 'aria-label': 'Dark glass tint' });
  const blur = h('input.range', { type: 'range', min: 0, max: 40, step: 1, 'aria-label': 'Background blur' });
  const tintVal = h('span.range-value');
  const blurVal = h('span.range-value');

  const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const upload = pressable(h('button.btn.btn-primary', { type: 'button' }, icon('image', { size: 18 }), ' Choose photo'));
  const reset = pressable(h('button.btn.btn-ghost', { type: 'button' }, 'Reset'));
  const inheritNote = h('p.muted.small');

  upload.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    upload.disabled = true;
    upload.lastChild.textContent = ' Uploading…';
    try {
      await uploadWallpaper(f, scope);
      toast('Wallpaper updated for both of you', { tone: 'ok' });
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      upload.disabled = false;
      upload.lastChild.textContent = ' Choose photo';
    }
  });
  reset.addEventListener('click', async () => {
    try { await resetScope(scope); toast(scope === 'global' ? 'Wallpaper removed' : 'Now using the global wallpaper'); }
    catch (err) { toast(err.message, { tone: 'error' }); }
  });

  tint.addEventListener('input', () => setAdjustments(scope, { tint: Number(tint.value) }));
  blur.addEventListener('input', () => setAdjustments(scope, { blur: Number(blur.value) }));
  scopeSelect.addEventListener('change', () => { scope = scopeSelect.value; sync(store.get()); });

  const sync = (s) => {
    const own = s.wallpapers[scope];
    const eff = selectors.wallpaperFor(s, scope);
    const t = eff?.tint ?? 55;
    const b = eff?.blur ?? 0;
    if (document.activeElement !== tint) tint.value = t;
    if (document.activeElement !== blur) blur.value = b;
    tintVal.textContent = `${tint.value}%`;
    blurVal.textContent = `${blur.value}px`;
    const url = eff?.storage_path ? s.wallpaperUrls[eff.storage_path] : null;
    preview.style.setProperty('--prev-img', url ? `url("${url.replace(/"/g, '%22')}")` : 'none');
    preview.style.setProperty('--prev-tint', (Number(tint.value) / 100).toFixed(2));
    preview.style.setProperty('--prev-blur', `${blur.value}px`);
    inheritNote.textContent = scope === 'global'
      ? 'Shown on every tab that has no wallpaper of its own.'
      : own && !own.inherit
        ? (own.storage_path ? `${SCOPE_LABELS[scope]} has its own photo.` : `${SCOPE_LABELS[scope]} uses the global photo with its own tint and blur.`)
        : `${SCOPE_LABELS[scope]} is using the global wallpaper. Move a slider or pick a photo to customise it.`;
  };
  unsubs.push(store.select((s) => ({ w: s.wallpapers, u: s.wallpaperUrls }), () => sync(store.get())));

  return section('Wallpaper',
    row('Apply to', scopeSelect),
    preview,
    h('div.btn-row', upload, reset), file, inheritNote,
    h('div.slider-row', h('span.field-label', 'Dark glass tint'), tint, tintVal),
    h('div.slider-row', h('span.field-label', 'Blur'), blur, blurVal),
    h('p.muted.small', 'Changes show up live on your partner’s screen.'));
}

// ---------------------------------------------------------------------------
function lockSection() {
  const wrap = h('div');
  const render = async () => {
    clear(wrap);
    const prefs = store.get().prefs;
    const bioOk = await biometricAvailable();

    const pinBtn = pressable(h('button.btn.btn-glass', { type: 'button' }, hasPin() ? 'Change PIN' : 'Set PIN'));
    pinBtn.addEventListener('click', async () => { if (await promptNewPin()) render(); });

    const bio = toggle(hasBiometric(), async (on, input) => {
      try {
        if (on) {
          if (!hasPin()) {
            toast('Set a backup PIN first');
            if (!(await promptNewPin())) { input.checked = false; return; }
          }
          await enrollBiometric();
          toast(`${biometricLabel()} is on`, { tone: 'ok' });
        } else {
          disableBiometric();
        }
      } catch (err) {
        input.checked = false;
        toast(err.name === 'NotAllowedError' ? 'Cancelled' : err.message, { tone: 'error' });
      }
      render();
    }, biometricLabel());

    const minutes = h('select.input', { 'aria-label': 'Auto-lock after' },
      [0, 1, 5, 15, 60].map((m) => h('option', { value: m }, m === 0 ? 'Immediately' : `${m} min`)));
    minutes.value = String(prefs.autoLockMinutes ?? 5);
    minutes.addEventListener('change', () => store.set({ prefs: { autoLockMinutes: Number(minutes.value) } }));

    const lockBtn = pressable(h('button.btn.btn-ghost', { type: 'button' }, icon('lock', { size: 18 }), ' Lock now'));
    lockBtn.addEventListener('click', () => { document.querySelector('.sheet-backdrop')?.click(); lockNow('manual'); });

    const off = pressable(h('button.btn.btn-ghost.danger', { type: 'button' }, 'Turn off app lock'));
    off.addEventListener('click', () => { disableBiometric(); clearLockSecrets(); toast('App lock off'); render(); });

    wrap.append(
      row('PIN', pinBtn, '4 digits, stored hashed on this device only'),
      bioOk
        ? row(biometricLabel(), bio, 'Unlock with your face or finger')
        : h('p.muted.small', `${biometricLabel()} isn't available in this browser. ${isIOS() && !isStandalone() ? 'Install to Home Screen and try again.' : ''}`),
      prefs.lockEnabled ? row('Auto-lock', minutes) : null,
      prefs.lockEnabled ? h('div.btn-row', lockBtn, off) : null,
      h('p.muted.small', 'This lock keeps the app private on this phone. Your data is protected by your account sign-in on the server.')
    );
  };
  render();
  return section('App lock', wrap);
}

// ---------------------------------------------------------------------------
function pushSection() {
  const wrap = h('div');
  const render = () => {
    clear(wrap);
    const support = pushSupport();
    if (!support.ok) { wrap.append(h('p.muted.small', support.reason)); return; }
    const on = pushPermission() === 'granted';
    wrap.append(row('Notifications', toggle(on, async (val, input) => {
      try {
        if (val) { await enablePush(); toast('Notifications on', { tone: 'ok' }); }
        else { await disablePush(); toast('Notifications off on this device'); }
      } catch (err) { input.checked = !val; toast(err.message, { tone: 'error' }); }
      render();
    }, 'Notifications'), 'Love pings, new TikToks, bills, answers'));
  };
  render();
  return section('Notifications', wrap);
}

// ---------------------------------------------------------------------------
function motionSection() {
  const prefs = store.get().prefs;
  const parts = [
    row('3D parallax', toggle(prefs.parallax, async (v) => {
      store.set({ prefs: { parallax: v } });
      if (v && motionNeedsPermission()) await requestMotionPermission();
    }, '3D parallax'), 'Tilt your phone to move the scene'),
    row('Reduce motion', toggle(prefs.reduceMotion, (v) => store.set({ prefs: { reduceMotion: v } }), 'Reduce motion')),
    row('Haptics', toggle(prefs.haptics, (v) => store.set({ prefs: { haptics: v } }), 'Haptics'),
      isIOS() ? 'iPhone: works on iOS 18+' : null)
  ];
  if (motionNeedsPermission()) {
    const b = pressable(h('button.btn.btn-glass', { type: 'button' }, 'Enable tilt sensor'));
    b.addEventListener('click', async () => {
      const ok = await requestMotionPermission();
      toast(ok ? 'Tilt enabled' : 'Motion access was denied', { tone: ok ? 'ok' : 'error' });
      b.remove();
    });
    parts.push(b);
  }
  return section('Motion & feel', ...parts);
}

// ---------------------------------------------------------------------------
function spaceSection() {
  const { couple, partner, session } = store.get();
  const out = pressable(h('button.btn.btn-ghost.danger', { type: 'button' }, 'Sign out'));
  out.addEventListener('click', signOut);
  return section('Your space',
    row('Signed in as', h('span.muted', session?.user?.email || '')),
    row('Partner', h('span.muted', partner?.display_name || 'Waiting to join')),
    couple?.invite_code ? row('Invite code', h('code.code', couple.invite_code)) : null,
    couple ? row('Hide pork dishes', toggle(couple.hide_pork, async (v, input) => {
      const { error } = await supabase.from('couples').update({ hide_pork: v }).eq('id', couple.id);
      if (error) { input.checked = !v; toast(error.message, { tone: 'error' }); return; }
      store.replace('couple', { ...store.get().couple, hide_pork: v });
    }, 'Hide pork dishes'), 'Filters the dinner swiper for both of you') : null,
    out);
}

// ---------------------------------------------------------------------------
function enableSwipeToClose(sheet, close) {
  let startY = 0;
  let dy = 0;
  let dragging = false;
  const grab = sheet.querySelector('.sheet-grabber');
  const header = sheet.querySelector('.sheet-header');
  for (const el of [grab, header]) {
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;      // let the close button click normally
      dragging = true; startY = e.clientY; dy = 0; sheet.style.transition = 'none'; el.setPointerCapture(e.pointerId); });
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
