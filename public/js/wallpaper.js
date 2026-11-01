/* Couples App · custom wallpaper engine
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 *  - One shared wallpaper per scope: 'global', 'lock', or a tab id.
 *    Tab scopes with inherit=true fall back to 'global'.
 *  - Photos are downscaled + re-encoded on-device before upload (keeps the
 *    free 1 GB Storage tier healthy and strips most EXIF/location metadata).
 *  - Tint (0–95 %) and blur (0–40 px) update instantly on this screen,
 *    stream live to the partner's screen over a Realtime broadcast while
 *    the slider moves, and persist to Postgres once the slider settles.
 *  - Blur is applied with `filter` on the photo layer, not backdrop-filter,
 *    which is far cheaper on phones.
 */
import { CONFIG } from './config.js';
import { store, selectors, toast } from './store.js';
import { supabase, unwrap } from './supabase.js';
import { broadcast } from './realtime.js';

export const SCOPES = ['global', 'lock', 'spark', 'vault', 'money', 'wishlist', 'discover'];
const BUCKET = 'wallpapers';

let layers = [];
let activeLayer = 0;
let shownUrl = null;
const urlRequests = new Map();

export function initWallpaperEngine(host) {
  host.innerHTML = '';
  layers = [0, 1].map(() => {
    const el = document.createElement('div');
    el.className = 'wp-layer';
    host.append(el);
    return el;
  });
  const tint = document.createElement('div');
  tint.className = 'wp-tint';
  host.append(tint);

  // Re-apply whenever the tab, lock state, or any wallpaper row changes.
  store.select(
    (s) => {
      const scope = s.lock.locked ? 'lock' : s.ui.tab;
      const wp = selectors.wallpaperFor(s, scope);
      return {
        path: wp?.storage_path || null,
        tint: wp?.tint ?? 55,
        blur: wp?.blur ?? 0,
        url: wp?.storage_path ? s.wallpaperUrls[wp.storage_path] || null : null
      };
    },
    (v) => apply(v)
  );
}

function apply({ path, tint, blur, url }) {
  const root = document.documentElement;
  root.style.setProperty('--wp-tint', (tint / 100).toFixed(2));
  root.style.setProperty('--wp-blur', `${blur}px`);
  root.classList.toggle('has-wallpaper', Boolean(path));

  if (path && !url) { ensureSignedUrl(path); return; }
  if (url === shownUrl) return;
  shownUrl = url;

  const next = layers[1 - activeLayer];
  const prev = layers[activeLayer];
  if (!url) {
    prev.classList.remove('visible');
    next.classList.remove('visible');
    return;
  }
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    if (shownUrl !== url) return;           // a newer wallpaper won the race
    next.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
    next.classList.add('visible');
    prev.classList.remove('visible');
    activeLayer = 1 - activeLayer;
  };
  img.onerror = () => {
    // Signed URL probably expired: drop it so it is re-signed on next apply.
    const urls = { ...store.get().wallpaperUrls };
    delete urls[path];
    store.replace('wallpaperUrls', urls);
  };
  img.src = url;
}

async function ensureSignedUrl(path) {
  if (urlRequests.has(path)) return urlRequests.get(path);
  const p = supabase.storage.from(BUCKET)
    .createSignedUrl(path, CONFIG.SIGNED_URL_TTL_SECONDS)
    .then(({ data, error }) => {
      if (error) throw error;
      store.set({ wallpaperUrls: { [path]: data.signedUrl } });
      return data.signedUrl;
    })
    .catch((err) => console.warn('[wallpaper] sign failed', err))
    .finally(() => setTimeout(() => urlRequests.delete(path), 30_000));
  urlRequests.set(path, p);
  return p;
}

export async function loadWallpapers() {
  const rows = unwrap(await supabase.from('wallpaper_settings').select('*'));
  const map = {};
  for (const r of rows) map[r.scope] = r;
  store.replace('wallpapers', map);
}

/** Realtime: a row changed in Postgres. */
export function onWallpaperRow(row, eventType) {
  const map = { ...store.get().wallpapers };
  if (eventType === 'DELETE') delete map[row.scope];
  else map[row.scope] = row;
  store.replace('wallpapers', map);
}

/** Realtime broadcast: partner is dragging a slider right now. */
export function onWallpaperPreview({ scope, tint, blur }) {
  if (!SCOPES.includes(scope)) return;
  const cur = store.get().wallpapers[scope] || { scope, tint: 55, blur: 0, inherit: scope !== 'global' };
  store.set({ wallpapers: { [scope]: { ...cur, tint, blur } } });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
function rowFor(scope) {
  return store.get().wallpapers[scope] || { scope, tint: 55, blur: 0, inherit: scope !== 'global', storage_path: null };
}

const persistTimers = new Map();
function persistSoon(scope, patch) {
  clearTimeout(persistTimers.get(scope));
  persistTimers.set(scope, setTimeout(async () => {
    persistTimers.delete(scope);
    const { error } = await supabase.from('wallpaper_settings')
      .upsert({ ...stripMeta(rowFor(scope)), ...patch, scope }, { onConflict: 'couple_id,scope' });
    if (error) toast(`Couldn't save wallpaper: ${error.message}`, { tone: 'error' });
  }, 450));
}

const stripMeta = ({ updated_at, updated_by, couple_id, ...rest }) => rest;

let lastBroadcast = 0;
export function setAdjustments(scope, { tint, blur }) {
  const cur = rowFor(scope);
  const next = {
    ...cur,
    tint: clampInt(tint ?? cur.tint, 0, 95),
    blur: clampInt(blur ?? cur.blur, 0, 40),
    inherit: scope === 'global' ? true : false
  };
  store.set({ wallpapers: { [scope]: next } });

  const now = performance.now();
  if (now - lastBroadcast > 60) {             // ~16 fps live preview for the partner
    lastBroadcast = now;
    broadcast('wallpaper:preview', { scope, tint: next.tint, blur: next.blur });
  }
  persistSoon(scope, { tint: next.tint, blur: next.blur, inherit: next.inherit, storage_path: next.storage_path });
}

export async function uploadWallpaper(file, scope = 'global') {
  if (!file || !file.type.startsWith('image/')) throw new Error('Choose a photo');
  const { me, session } = store.get();
  if (!me?.couple_id) throw new Error('Pair with your partner first');

  const blob = await compressImage(file);
  const path = `${me.couple_id}/${session.user.id}/${scope}-${Date.now()}.jpg`;
  unwrap(await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
    cacheControl: '31536000',
    upsert: false
  }));

  const prev = rowFor(scope);
  const row = { ...stripMeta(prev), scope, storage_path: path, inherit: false };
  if (scope === 'global') row.inherit = true;
  store.set({ wallpapers: { [scope]: row } });
  unwrap(await supabase.from('wallpaper_settings').upsert(row, { onConflict: 'couple_id,scope' }));
  await ensureSignedUrl(path);

  // Clean up the photo this replaced, if it was ours and nothing else uses it.
  if (prev.storage_path && prev.storage_path.includes(`/${session.user.id}/`)) {
    const stillUsed = Object.values(store.get().wallpapers).some((w) => w.storage_path === prev.storage_path);
    if (!stillUsed) supabase.storage.from(BUCKET).remove([prev.storage_path]).catch(() => {});
  }
  return path;
}

export async function resetScope(scope) {
  if (scope === 'global') {
    const row = { ...stripMeta(rowFor('global')), storage_path: null, tint: 55, blur: 0 };
    store.set({ wallpapers: { global: row } });
    unwrap(await supabase.from('wallpaper_settings').upsert(row, { onConflict: 'couple_id,scope' }));
    return;
  }
  const row = { ...stripMeta(rowFor(scope)), scope, inherit: true, storage_path: null };
  store.set({ wallpapers: { [scope]: row } });
  unwrap(await supabase.from('wallpaper_settings').upsert(row, { onConflict: 'couple_id,scope' }));
}

// ---------------------------------------------------------------------------
// Image pipeline
// ---------------------------------------------------------------------------
async function compressImage(file) {
  const max = CONFIG.WALLPAPER_MAX_EDGE_PX;
  let source;
  try {
    // imageOrientation honours EXIF rotation from phone cameras.
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This photo format is not supported here. Try a JPEG or PNG.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = source.width;
  const hgt = source.height;
  const scale = Math.min(1, max / Math.max(w, hgt));
  const cw = Math.round(w * scale);
  const ch = Math.round(hgt * scale);

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, cw, ch);
  source.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', CONFIG.WALLPAPER_JPEG_QUALITY));
  if (!blob) throw new Error('Could not process this photo');
  return blob;
}

const clampInt = (v, a, b) => Math.round(Math.min(b, Math.max(a, Number(v) || 0)));
