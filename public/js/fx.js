/* Couples App · depth & motion engine
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Everything here animates transform/opacity only (GPU-composited), is
 * throttled to one write per animation frame, and is disabled entirely
 * under prefers-reduced-motion or the in-app "Reduce motion" preference.
 *
 *  - Ambient parallax: device tilt (gyroscope) or pointer position moves the
 *    wallpaper, glow orbs and cards on separate depth planes.
 *  - Card tilt: glass cards rotate in 3D toward the pointer/finger with a
 *    specular highlight that tracks the contact point.
 *  - Particle burst: full-screen hearts/sparkles with perspective scaling.
 */
import { store } from './store.js';

const root = document.documentElement;
const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = window.matchMedia('(pointer: fine)');

export const motionAllowed = () => !mqReduce.matches && !store.get().prefs.reduceMotion;

// ---------------------------------------------------------------------------
// Ambient parallax
// ---------------------------------------------------------------------------
let target = { x: 0, y: 0 };
let current = { x: 0, y: 0 };
let rafId = 0;
let orientationBound = false;

function loop() {
  // Critically-damped follow: smooth without overshoot.
  current.x += (target.x - current.x) * 0.08;
  current.y += (target.y - current.y) * 0.08;
  root.style.setProperty('--px', current.x.toFixed(4));
  root.style.setProperty('--py', current.y.toFixed(4));
  if (Math.abs(target.x - current.x) > 0.0005 || Math.abs(target.y - current.y) > 0.0005) {
    rafId = requestAnimationFrame(loop);
  } else {
    rafId = 0;
  }
}

function nudge(x, y) {
  if (!motionAllowed() || !store.get().prefs.parallax) { x = 0; y = 0; }
  target = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
  if (!rafId) rafId = requestAnimationFrame(loop);
}

function onPointer(e) {
  if (e.pointerType !== 'mouse') return;
  nudge((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
}

let baseBeta = null;
function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  // Calibrate to however the phone is being held when the first event arrives.
  if (baseBeta === null) baseBeta = e.beta;
  nudge(e.gamma / 28, (e.beta - baseBeta) / 28);
}

function bindOrientation() {
  if (orientationBound) return;
  orientationBound = true;
  window.addEventListener('deviceorientation', onOrientation, { passive: true });
}

/** iOS requires a user gesture to grant motion access. Call from a tap handler. */
export async function requestMotionPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try {
      const res = await DOE.requestPermission();
      if (res === 'granted') { bindOrientation(); return true; }
      return false;
    } catch { return false; }
  }
  bindOrientation();
  return true;
}

export const motionNeedsPermission = () =>
  typeof window.DeviceOrientationEvent?.requestPermission === 'function' && !orientationBound;

export function initAmbient() {
  window.addEventListener('pointermove', onPointer, { passive: true });
  // Android/desktop grant orientation without a prompt.
  if (!motionNeedsPermission()) bindOrientation();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { baseBeta = null; nudge(0, 0); }
  });
  store.select((s) => s.prefs.reduceMotion, (rm) => {
    root.classList.toggle('reduce-motion', Boolean(rm) || mqReduce.matches);
    if (rm) nudge(0, 0);
  });
  mqReduce.addEventListener?.('change', () =>
    root.classList.toggle('reduce-motion', mqReduce.matches || store.get().prefs.reduceMotion));
}

// ---------------------------------------------------------------------------
// 3D card tilt with specular highlight
// ---------------------------------------------------------------------------
const MAX_TILT = 9; // degrees

export function tilt(el, { max = MAX_TILT } = {}) {
  let frame = 0;
  let pending = null;
  let releaseTimer = 0;

  const apply = () => {
    frame = 0;
    if (!pending) return;
    const { rx, ry, mx, my } = pending;
    el.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
    el.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
    el.style.setProperty('--mx', `${mx.toFixed(1)}%`);
    el.style.setProperty('--my', `${my.toFixed(1)}%`);
  };

  const update = (clientX, clientY) => {
    if (!motionAllowed()) return;
    const r = el.getBoundingClientRect();
    const nx = (clientX - r.left) / r.width;   // 0..1
    const ny = (clientY - r.top) / r.height;
    pending = {
      rx: (0.5 - ny) * max * 2,
      ry: (nx - 0.5) * max * 2,
      mx: nx * 100,
      my: ny * 100
    };
    el.classList.add('is-tilting');
    if (!frame) frame = requestAnimationFrame(apply);
  };

  const reset = () => {
    pending = { rx: 0, ry: 0, mx: 50, my: 0 };
    if (!frame) frame = requestAnimationFrame(apply);
    el.classList.remove('is-tilting');
  };

  el.addEventListener('pointermove', (e) => {
    // Touch tilts only while pressed, so scrolling a list never wobbles cards.
    if (e.pointerType === 'mouse' && !finePointer.matches) return;
    if (e.pointerType !== 'mouse' && e.buttons === 0) return;
    update(e.clientX, e.clientY);
  }, { passive: true });
  el.addEventListener('pointerdown', (e) => {
    clearTimeout(releaseTimer);
    update(e.clientX, e.clientY);
  }, { passive: true });
  el.addEventListener('pointerleave', reset, { passive: true });
  el.addEventListener('pointercancel', reset, { passive: true });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') releaseTimer = setTimeout(reset, 120);
  }, { passive: true });

  el.classList.add('tilt');
  return el;
}

// ---------------------------------------------------------------------------
// Particle burst (Send Love / matches / celebrations)
// ---------------------------------------------------------------------------
const PALETTES = {
  love: ['#ff2d78', '#ff6aa2', '#ffb3cf', '#ffffff', '#7a5cff'],
  match: ['#ffd36e', '#ff2d78', '#6f6bff', '#ffffff'],
  calm: ['#6f6bff', '#9e8cff', '#c9c2ff', '#ffffff']
};

export function burst({ kind = 'love', originX, originY, count } = {}) {
  const reduced = !motionAllowed();
  const n = count ?? (reduced ? 0 : Math.min(90, Math.round((innerWidth * innerHeight) / 7000)));
  if (n === 0) return Promise.resolve();

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const palette = PALETTES[kind] || PALETTES.love;
  const ox = originX ?? innerWidth / 2;
  const oy = originY ?? innerHeight * 0.62;
  const focal = 420;

  const particles = Array.from({ length: n }, (_, i) => {
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.6;
    const speed = 4 + Math.random() * 7;
    return {
      x: 0, y: 0, z: Math.random() * 260 - 80,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 6,
      vz: (Math.random() - 0.5) * 9,
      size: 7 + Math.random() * 12,
      spin: (Math.random() - 0.5) * 0.3,
      rot: Math.random() * Math.PI,
      color: palette[i % palette.length],
      shape: Math.random() < 0.62 ? 'heart' : 'spark',
      life: 0,
      ttl: 70 + Math.random() * 50
    };
  });

  return new Promise((resolve) => {
    const step = () => {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      let alive = 0;
      for (const p of particles) {
        if (p.life++ > p.ttl) continue;
        alive++;
        p.vy += 0.22;            // gravity
        p.vx *= 0.985; p.vy *= 0.985; p.vz *= 0.985;
        p.x += p.vx; p.y += p.vy; p.z += p.vz;
        p.rot += p.spin;
        const scale = focal / (focal + p.z);           // perspective projection
        const sx = ox + p.x * scale;
        const sy = oy + p.y * scale;
        const fade = 1 - p.life / p.ttl;
        ctx.save();
        ctx.globalAlpha = Math.max(0, fade) * Math.min(1, scale);
        ctx.translate(sx, sy);
        ctx.rotate(p.rot);
        ctx.scale(scale, scale);
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 14;
        if (p.shape === 'heart') drawHeart(ctx, p.size);
        else drawSpark(ctx, p.size * 0.7);
        ctx.restore();
      }
      if (alive > 0) requestAnimationFrame(step);
      else { canvas.remove(); resolve(); }
    };
    requestAnimationFrame(step);
  });
}

function drawHeart(ctx, s) {
  const k = s / 16;
  ctx.beginPath();
  ctx.moveTo(0, 5 * k);
  ctx.bezierCurveTo(-1 * k, 3.6 * k, -8 * k, -0.5 * k, -8 * k, -4.5 * k);
  ctx.bezierCurveTo(-8 * k, -8.5 * k, -3 * k, -9.5 * k, 0, -5.5 * k);
  ctx.bezierCurveTo(3 * k, -9.5 * k, 8 * k, -8.5 * k, 8 * k, -4.5 * k);
  ctx.bezierCurveTo(8 * k, -0.5 * k, 1 * k, 3.6 * k, 0, 5 * k);
  ctx.fill();
}

function drawSpark(ctx, s) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? s : s * 0.28;
    const a = (Math.PI / 4) * i;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
