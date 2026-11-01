/* Couples App · sign-in and pairing
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Sign-in options (both keep the user inside the installed PWA):
 *   - Email + password.
 *   - Email one-time code (6 digits). Requires the Supabase "Magic Link"
 *     email template to include {{ .Token }} (see README).
 * Magic links are deliberately NOT used: on iPhone they open in Safari,
 * which does not share storage with the home-screen app.
 *
 * Pairing: the first partner creates the space (seat A) and gets an
 * 8-character invite code; the second partner joins with it (seat B), and
 * the code is burned. The database refuses a third person.
 */
import { store, toast, upsertProfile } from './store.js';
import { supabase, unwrap } from './supabase.js';
import { h, icon, clear, pressable } from './ui.js';
import { tilt } from './fx.js';

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  store.replace('session', data.session);
  return data.session;
}

export function onAuthChange(cb) {
  supabase.auth.onAuthStateChange((event, session) => {
    const prev = store.get().session;
    store.replace('session', session);
    if ((prev?.user?.id || null) !== (session?.user?.id || null)) cb(event, session);
  });
}

export async function loadIdentity() {
  const uid = store.get().session.user.id;
  const profiles = unwrap(await supabase.from('profiles').select('*'));
  const me = profiles.find((p) => p.id === uid) || null;
  const partner = profiles.find((p) => p.id !== uid && me?.couple_id && p.couple_id === me.couple_id) || null;
  let couple = null;
  if (me?.couple_id) {
    couple = unwrap(await supabase.from('couples').select('*').eq('id', me.couple_id).maybeSingle());
  }
  store.set({ me, partner, couple });
  return { me, partner, couple };
}

export function onProfileRow(row, _old, eventType) {
  if (eventType === 'DELETE') return;
  upsertProfile(row);
}

export function onCoupleRow(row, _old, eventType) {
  if (eventType === 'DELETE') { store.replace('couple', null); return; }
  if (row?.id === store.get().me?.couple_id) store.replace('couple', row);
}

export async function signOut() {
  await supabase.auth.signOut();
  location.hash = '#/spark';
  location.reload();
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function field(label, attrs) {
  const input = h('input.input', attrs);
  return { wrap: h('label.field', h('span.field-label', label), input), input };
}

function brand() {
  return h('div.brand-hero', { 'aria-hidden': 'true' },
    h('div.lock-orbit.small',
      h('div.orbit-ring.r1'), h('div.orbit-ring.r2'), h('div.orbit-ring.r3'),
      h('div.orbit-core', icon('spark', { size: 28, stroke: 1.4 }))));
}

/** Renders the sign-in card and resolves once a session exists. */
export function renderSignIn(host) {
  clear(host);
  let mode = 'password';          // 'password' | 'code'
  let codeSent = false;

  const email = field('Email', { type: 'email', autocomplete: 'email', inputmode: 'email', required: true, placeholder: 'you@example.com' });
  const password = field('Password', { type: 'password', autocomplete: 'current-password', minlength: 8, placeholder: '8+ characters' });
  const code = field('6-digit code', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '\\d{6}', placeholder: '••••••' });
  const error = h('p.form-error', { role: 'alert' });

  const primary = pressable(h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Sign in'));
  const secondary = pressable(h('button.btn.btn-ghost.btn-block', { type: 'button' }, 'Create account'));
  const switcher = h('button.link', { type: 'button' }, 'Email me a code instead');

  const sync = () => {
    password.wrap.hidden = mode !== 'password';
    code.wrap.hidden = !(mode === 'code' && codeSent);
    secondary.hidden = mode !== 'password';
    primary.textContent = mode === 'password' ? 'Sign in' : codeSent ? 'Verify code' : 'Send code';
    switcher.textContent = mode === 'password' ? 'Email me a code instead' : 'Use a password instead';
    error.textContent = '';
  };

  const busy = async (btn, fn) => {
    btn.disabled = true;
    error.textContent = '';
    try { await fn(); } catch (err) { error.textContent = err.message; } finally { btn.disabled = false; }
  };

  const form = h('form.auth-card.glass.tilt-card', { novalidate: true },
    brand(),
    h('h1.title-xl', 'Your private space'),
    h('p.muted', 'For two people. Synced live.'),
    email.wrap, password.wrap, code.wrap, error, primary, secondary, switcher);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(primary, async () => {
      const em = email.input.value.trim();
      if (!/^\S+@\S+\.\S+$/.test(em)) throw new Error('Enter a valid email');
      if (mode === 'password') {
        unwrap(await supabase.auth.signInWithPassword({ email: em, password: password.input.value }));
      } else if (!codeSent) {
        unwrap(await supabase.auth.signInWithOtp({ email: em, options: { shouldCreateUser: true } }));
        codeSent = true;
        sync();
        toast('Check your email for a 6-digit code');
        code.input.focus();
      } else {
        unwrap(await supabase.auth.verifyOtp({ email: em, token: code.input.value.trim(), type: 'email' }));
      }
    });
  });

  secondary.addEventListener('click', () => busy(secondary, async () => {
    const em = email.input.value.trim();
    const pw = password.input.value;
    if (!/^\S+@\S+\.\S+$/.test(em)) throw new Error('Enter a valid email');
    if (pw.length < 8) throw new Error('Use at least 8 characters');
    const data = unwrap(await supabase.auth.signUp({ email: em, password: pw }));
    if (!data.session) toast('Confirm your email, then sign in', { ms: 5000 });
  }));

  switcher.addEventListener('click', () => {
    mode = mode === 'password' ? 'code' : 'password';
    codeSent = false;
    sync();
  });

  sync();
  host.append(h('div.center-stage', tilt(form, { max: 5 })));
}

/** Renders create/join pairing. Resolves when the user has a couple. */
export function renderPairing(host, onDone) {
  clear(host);
  const me = store.get().me;
  const name = field('Your display name', { type: 'text', maxlength: 32, autocomplete: 'nickname', value: me?.display_name === 'Partner' ? '' : me?.display_name || '', placeholder: 'What your partner sees' });
  const invite = field('Invite code', { type: 'text', maxlength: 8, autocapitalize: 'characters', autocomplete: 'off', placeholder: 'ABCD1234' });
  const error = h('p.form-error', { role: 'alert' });

  const createBtn = pressable(h('button.btn.btn-primary.btn-block', { type: 'button' }, 'Create our space'));
  const joinBtn = pressable(h('button.btn.btn-glass.btn-block', { type: 'button' }, 'Join with code'));

  const run = async (btn, fn) => {
    btn.disabled = true; error.textContent = '';
    try { await fn(); } catch (err) { error.textContent = friendly(err); } finally { btn.disabled = false; }
  };

  createBtn.addEventListener('click', () => run(createBtn, async () => {
    const dn = name.input.value.trim();
    if (!dn) throw new Error('Pick a display name first');
    unwrap(await supabase.rpc('create_couple', { p_display_name: dn, p_couple_name: 'Us' }));
    await loadIdentity();
    onDone();
  }));

  joinBtn.addEventListener('click', () => run(joinBtn, async () => {
    const dn = name.input.value.trim();
    const code = invite.input.value.trim().toUpperCase();
    if (!dn) throw new Error('Pick a display name first');
    if (!/^[A-Z0-9]{8}$/.test(code)) throw new Error('Invite codes are 8 letters/numbers');
    unwrap(await supabase.rpc('join_couple', { p_invite_code: code, p_display_name: dn }));
    await loadIdentity();
    onDone();
  }));

  const signOutBtn = h('button.link', { type: 'button' }, 'Sign out');
  signOutBtn.addEventListener('click', signOut);

  const card = h('div.auth-card.glass',
    brand(),
    h('h1.title-xl', 'Pair your space'),
    h('p.muted', 'One of you creates it. The other joins with the code.'),
    name.wrap, createBtn,
    h('div.divider', h('span', 'or')),
    invite.wrap, joinBtn, error, signOutBtn);
  host.append(h('div.center-stage', tilt(card, { max: 5 })));
}

/** Shown to partner A while waiting for partner B to join. */
export function renderWaiting(host) {
  clear(host);
  const code = store.get().couple?.invite_code || '········';
  const copy = pressable(h('button.btn.btn-glass', { type: 'button' }, 'Copy code'));
  copy.addEventListener('click', async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Join our space', text: `Our invite code: ${code}`, url: location.origin });
      else { await navigator.clipboard.writeText(code); toast('Copied'); }
    } catch { /* share sheet dismissed */ }
  });
  const signOutBtn = h('button.link', { type: 'button' }, 'Sign out');
  signOutBtn.addEventListener('click', signOut);
  host.append(h('div.center-stage',
    tilt(h('div.auth-card.glass',
      brand(),
      h('h1.title-xl', 'Waiting for your partner'),
      h('p.muted', 'Have them install the app, sign in, and enter this code.'),
      h('div.invite-code', { 'aria-label': `Invite code ${code.split('').join(' ')}` }, code.split('').map((c) => h('span', c))),
      copy,
      h('p.muted.small', 'This screen updates the moment they join.'),
      signOutBtn), { max: 5 })));
}

function friendly(err) {
  const m = err.message || '';
  if (m.includes('invalid invite code')) return "That code doesn't match a space waiting for a partner.";
  if (m.includes('two partners')) return 'That space already has two people.';
  if (m.includes('already in a couple')) return "You're already paired.";
  return m;
}
