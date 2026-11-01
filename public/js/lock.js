/* Couples App · biometric lock (WebAuthn) + PIN fallback
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * WHAT THIS IS: a privacy curtain over an already signed-in session, the same
 * idea as an app lock in a banking app. It stops someone who picks up an
 * unlocked phone from opening your space.
 *
 * WHAT THIS IS NOT: server-verified authentication. The WebAuthn assertion is
 * checked for success on-device only, and the PIN hash lives in this device's
 * storage. Your data is protected server-side by Supabase Auth + RLS, not by
 * this lock. The public key IS uploaded to webauthn_credentials so an Edge
 * Function can verify assertions server-side later if you want that.
 *
 * Constraints worth knowing:
 *  - WebAuthn needs HTTPS (or localhost) and is bound to the exact hostname.
 *    Moving from *.pages.dev to a custom domain means re-enrolling.
 *  - iOS only shows Face ID from a user tap, so the lock screen shows a
 *    button rather than auto-prompting on iPhone.
 */
import { store, toast } from './store.js';
import { supabase } from './supabase.js';
import { h, icon, clear, haptic, isIOS, pressable } from './ui.js';

const PBKDF2_ITERATIONS = 210_000;
const MAX_ATTEMPTS_BEFORE_DELAY = 5;

// ---------------------------------------------------------------------------
// Device-local secret storage (scoped per signed-in user)
// ---------------------------------------------------------------------------
const keyFor = (uid) => `us.lock.v1:${uid}`;

function readSecrets() {
  const uid = store.get().session?.user?.id;
  if (!uid) return {};
  try { return JSON.parse(localStorage.getItem(keyFor(uid)) || '{}'); } catch { return {}; }
}

function writeSecrets(patch) {
  const uid = store.get().session?.user?.id;
  if (!uid) return;
  const next = { ...readSecrets(), ...patch };
  try { localStorage.setItem(keyFor(uid), JSON.stringify(next)); } catch { /* ignore */ }
}

export function clearLockSecrets() {
  const uid = store.get().session?.user?.id;
  if (uid) localStorage.removeItem(keyFor(uid));
  store.set({ prefs: { lockEnabled: false, biometricEnabled: false } });
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s) => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

// ---------------------------------------------------------------------------
// PIN
// ---------------------------------------------------------------------------
async function derive(pin, salt, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 256);
  return b64url(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const hasPin = () => Boolean(readSecrets().pin?.hash);

export async function setPin(pin) {
  if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 digits');
  const salt = randomBytes(16);
  const hash = await derive(pin, salt);
  writeSecrets({ pin: { salt: b64url(salt), hash, iterations: PBKDF2_ITERATIONS }, failures: 0, lockoutUntil: 0 });
  store.set({ prefs: { lockEnabled: true } });
}

/** Returns { ok, waitMs } with escalating delays after repeated failures. */
export async function verifyPin(pin) {
  const s = readSecrets();
  const now = Date.now();
  if (s.lockoutUntil && now < s.lockoutUntil) return { ok: false, waitMs: s.lockoutUntil - now };
  if (!s.pin?.hash) return { ok: false, waitMs: 0 };

  const hash = await derive(pin, fromB64url(s.pin.salt), s.pin.iterations);
  if (timingSafeEqual(hash, s.pin.hash)) {
    writeSecrets({ failures: 0, lockoutUntil: 0 });
    return { ok: true, waitMs: 0 };
  }
  const failures = (s.failures || 0) + 1;
  const over = failures - MAX_ATTEMPTS_BEFORE_DELAY;
  const waitMs = over >= 0 ? Math.min(30_000 * 2 ** over, 15 * 60_000) : 0;
  writeSecrets({ failures, lockoutUntil: waitMs ? now + waitMs : 0 });
  return { ok: false, waitMs };
}

// ---------------------------------------------------------------------------
// WebAuthn (platform authenticator: Face ID / Touch ID / Android fingerprint)
// ---------------------------------------------------------------------------
export async function biometricAvailable() {
  if (!window.isSecureContext || !window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

export const hasBiometric = () => Boolean(readSecrets().credentialId);

export const biometricLabel = () => (isIOS() ? 'Face ID' : 'Fingerprint');

export async function enrollBiometric() {
  const { me, session } = store.get();
  if (!session) throw new Error('Sign in first');
  if (!(await biometricAvailable())) throw new Error(`${biometricLabel()} is not available on this device`);

  // userHandle is random per device enrollment, so no identifier leaks into the authenticator.
  const userHandle = randomBytes(32);
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: 'Us', id: location.hostname },
      user: {
        id: userHandle,
        name: session.user.email || 'partner',
        displayName: me?.display_name || 'Partner'
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },    // ES256 (iOS, Android)
        { type: 'public-key', alg: -257 }   // RS256 (Windows Hello)
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred'
      },
      attestation: 'none',
      timeout: 60_000
    }
  });
  if (!cred) throw new Error('Enrollment was cancelled');

  const credentialId = b64url(cred.rawId);
  writeSecrets({ credentialId, userHandle: b64url(userHandle) });
  store.set({ prefs: { biometricEnabled: true, lockEnabled: true } });

  // Best effort: store the public key for optional server-side verification later.
  try {
    const resp = cred.response;
    const spki = typeof resp.getPublicKey === 'function' ? resp.getPublicKey() : null;
    const alg = typeof resp.getPublicKeyAlgorithm === 'function' ? resp.getPublicKeyAlgorithm() : null;
    const transports = typeof resp.getTransports === 'function' ? resp.getTransports() : ['internal'];
    await supabase.from('webauthn_credentials').upsert({
      credential_id: credentialId,
      public_key: spki ? b64url(spki) : null,
      alg,
      transports,
      device_label: navigator.userAgentData?.platform || (isIOS() ? 'iPhone' : 'Android')
    }, { onConflict: 'credential_id' });
  } catch (err) {
    console.warn('[lock] could not store credential public key', err);
  }
  return true;
}

export async function unlockWithBiometric() {
  const { credentialId } = readSecrets();
  if (!credentialId) return false;
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: fromB64url(credentialId), transports: ['internal', 'hybrid'] }],
        userVerification: 'required',
        timeout: 60_000
      }
    });
    if (!assertion) return false;
    // userVerification:'required' means the OS only returns an assertion after
    // a successful Face ID / fingerprint match. Confirm the UV flag (bit 2).
    const flags = new Uint8Array(assertion.response.authenticatorData)[32];
    if (!(flags & 0x04)) return false;
    supabase?.from('webauthn_credentials')
      .update({ last_used_at: new Date().toISOString() })
      .eq('credential_id', credentialId)
      .then(() => {}, () => {});
    return true;
  } catch (err) {
    if (err?.name !== 'NotAllowedError') console.warn('[lock] biometric failed', err);
    return false;
  }
}

export function disableBiometric() {
  const { credentialId } = readSecrets();
  writeSecrets({ credentialId: null, userHandle: null });
  store.set({ prefs: { biometricEnabled: false } });
  if (credentialId) supabase?.from('webauthn_credentials').delete().eq('credential_id', credentialId).then(() => {}, () => {});
}

// ---------------------------------------------------------------------------
// Lock lifecycle
// ---------------------------------------------------------------------------
export const lockConfigured = () => store.get().prefs.lockEnabled && (hasPin() || hasBiometric());

export function lockNow(reason = 'manual') {
  if (!lockConfigured()) return;
  store.set({ lock: { locked: true, reason, method: null } });
}

function unlock(method) {
  store.set({ lock: { locked: false, method, reason: null } });
  haptic([10, 30, 10]);
}

let hiddenAt = 0;
export function initAutoLock() {
  if (lockConfigured()) lockNow('boot');
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    const minutes = Number(store.get().prefs.autoLockMinutes ?? 5);
    if (hiddenAt && Date.now() - hiddenAt >= minutes * 60_000) lockNow('timeout');
  });
}

// ---------------------------------------------------------------------------
// Lock screen UI
// ---------------------------------------------------------------------------
export function mountLockScreen(host) {
  let entered = '';
  let busy = false;
  let clockTimer = 0;

  const dots = h('div.pin-dots', { 'aria-hidden': 'true' }, [0, 1, 2, 3].map(() => h('span.pin-dot')));
  const status = h('p.lock-status', { role: 'status', 'aria-live': 'polite' }, '');
  const time = h('div.lock-time');
  const date = h('div.lock-date');
  const names = h('div.lock-names');

  const renderDots = () => [...dots.children].forEach((d, i) => d.classList.toggle('filled', i < entered.length));

  const fail = (msg) => {
    dots.classList.remove('shake');
    void dots.offsetWidth;          // restart the animation
    dots.classList.add('shake');
    haptic([30, 40, 30]);
    status.textContent = msg;
    entered = '';
    renderDots();
  };

  const submitPin = async () => {
    busy = true;
    const res = await verifyPin(entered);
    busy = false;
    if (res.ok) { entered = ''; renderDots(); status.textContent = ''; unlock('pin'); return; }
    if (res.waitMs) fail(`Too many tries. Wait ${Math.ceil(res.waitMs / 1000)}s.`);
    else fail('Wrong PIN');
  };

  const press = (digit) => {
    if (busy || entered.length >= 4) return;
    entered += digit;
    renderDots();
    haptic(5);
    if (entered.length === 4) submitPin();
  };

  const backspace = () => {
    entered = entered.slice(0, -1);
    renderDots();
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del'].map((k) => {
    if (k === 'bio') {
      const b = h('button.key.key-ghost', { type: 'button', 'aria-label': `Unlock with ${biometricLabel()}` },
        icon(isIOS() ? 'face' : 'finger', { size: 28 }));
      b.addEventListener('click', tryBiometric);
      b.hidden = !hasBiometric();
      return pressable(b, { haptics: false });
    }
    if (k === 'del') {
      const b = h('button.key.key-ghost', { type: 'button', 'aria-label': 'Delete' }, icon('back', { size: 26 }));
      b.addEventListener('click', backspace);
      return pressable(b, { haptics: false });
    }
    const b = h('button.key', { type: 'button' }, h('span.key-digit', k));
    b.addEventListener('click', () => press(k));
    return pressable(b, { haptics: false });
  });

  async function tryBiometric() {
    if (busy) return;
    busy = true;
    status.textContent = '';
    const ok = await unlockWithBiometric();
    busy = false;
    if (ok) unlock('biometric');
    else if (hasPin()) status.textContent = 'Use your PIN';
    else status.textContent = `${biometricLabel()} didn't match. Try again.`;
  }

  const bioButton = h('button.btn.btn-glass.lock-bio', { type: 'button' },
    icon(isIOS() ? 'face' : 'finger', { size: 22 }), ` Unlock with ${biometricLabel()}`);
  bioButton.addEventListener('click', tryBiometric);
  pressable(bioButton);

  const screen = h('section.lock-screen', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'App locked' },
    h('div.lock-orbit', { 'aria-hidden': 'true' },
      h('div.orbit-ring.r1'), h('div.orbit-ring.r2'), h('div.orbit-ring.r3'),
      h('div.orbit-core', icon('spark', { size: 34, stroke: 1.4 }))
    ),
    time, date, names,
    bioButton,
    dots,
    status,
    h('div.keypad', keys)
  );

  const onKey = (e) => {
    if (!store.get().lock.locked) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') backspace();
  };

  const tick = () => {
    const now = new Date();
    time.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
    date.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  };

  let wasLocked = false;
  store.select((s) => ({ locked: s.lock.locked, me: s.me?.display_name, partner: s.partner?.display_name }), (v) => {
    const justLocked = v.locked && !wasLocked;
    wasLocked = v.locked;
    host.classList.toggle('is-locked', v.locked);
    document.getElementById('app')?.toggleAttribute('inert', v.locked);
    names.textContent = [v.me, v.partner].filter(Boolean).join('  ♡  ');
    if (v.locked) {
      if (!host.contains(screen)) clear(host).append(screen);
      if (!justLocked) return;
      bioButton.hidden = !hasBiometric();
      keys[9].hidden = !hasBiometric();
      dots.hidden = !hasPin();
      screen.querySelector('.keypad').hidden = !hasPin();
      tick();
      clearInterval(clockTimer);
      clockTimer = setInterval(tick, 15_000);
      // Android/desktop allow prompting without a tap; iOS needs the button.
      if (justLocked && hasBiometric() && !isIOS()) setTimeout(tryBiometric, 350);
    } else {
      clearInterval(clockTimer);
      entered = '';
      renderDots();
      status.textContent = '';
    }
  });

  window.addEventListener('keydown', onKey);
}

/** Small modal flow used by Settings to choose a new PIN. */
export function promptNewPin() {
  return new Promise((resolve) => {
    let first = null;
    let entered = '';
    const title = h('h3.sheet-title', 'Choose a 4-digit PIN');
    const dots = h('div.pin-dots', [0, 1, 2, 3].map(() => h('span.pin-dot')));
    const render = () => [...dots.children].forEach((d, i) => d.classList.toggle('filled', i < entered.length));
    const close = (val) => { overlay.remove(); resolve(val); };

    const onDigit = async (d) => {
      if (entered.length >= 4) return;
      entered += d; render(); haptic(5);
      if (entered.length < 4) return;
      if (first === null) {
        first = entered; entered = '';
        title.textContent = 'Confirm your PIN';
        setTimeout(render, 120);
      } else if (first === entered) {
        await setPin(entered);
        toast('PIN saved', { tone: 'ok' });
        close(true);
      } else {
        first = null; entered = '';
        title.textContent = "PINs didn't match. Try again.";
        dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');
        setTimeout(render, 120);
      }
    };

    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k) => {
      if (!k) return h('span');
      const b = h('button.key' + (k === 'del' ? '.key-ghost' : ''), { type: 'button' },
        k === 'del' ? icon('back', { size: 24 }) : h('span.key-digit', k));
      b.addEventListener('click', () => (k === 'del' ? (entered = entered.slice(0, -1), render()) : onDigit(k)));
      return pressable(b, { haptics: false });
    });

    const cancel = h('button.btn.btn-ghost', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => close(false));
    const overlay = h('div.modal-backdrop',
      h('div.modal.glass', { role: 'dialog', 'aria-modal': 'true' }, title, dots, h('div.keypad.compact', keys), cancel));
    document.body.append(overlay);
  });
}
