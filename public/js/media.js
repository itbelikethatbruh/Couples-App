/* Couples App · media pipeline (images, signed URLs, uploads)
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 */
import { CONFIG } from './config.js';
import { store } from './store.js';
import { supabase, unwrap } from './supabase.js';

/**
 * Downscale + re-encode a photo on-device. Honors EXIF rotation and drops
 * most metadata (including GPS) because canvas output carries none.
 */
export async function compressImage(file, { maxEdge = 1600, quality = 0.85 } = {}) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This photo format is not supported here. Try a JPEG or PNG.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const cw = Math.round(source.width * scale);
  const ch = Math.round(source.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, cw, ch);
  source.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not process this photo');
  return blob;
}

/** Path convention required by storage RLS: {couple_id}/{user_id}/{name}. */
export function ownPath(name) {
  const { me, session } = store.get();
  if (!me?.couple_id) throw new Error('Pair with your partner first');
  return `${me.couple_id}/${session.user.id}/${name}`;
}

export async function uploadTo(bucket, name, blob, contentType) {
  const path = ownPath(name);
  unwrap(await supabase.storage.from(bucket).upload(path, blob, { contentType, cacheControl: '31536000', upsert: false }));
  return path;
}

// ---- Signed URL cache (per bucket) -------------------------------------------
const cache = new Map();          // `${bucket}:${path}` → { url, exp }
const MARGIN_MS = 5 * 60_000;

export async function signedUrls(bucket, paths) {
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const p of new Set(paths.filter(Boolean))) {
    const hit = cache.get(`${bucket}:${p}`);
    if (hit && hit.exp - MARGIN_MS > now) out[p] = hit.url;
    else missing.push(p);
  }
  if (missing.length) {
    const ttl = CONFIG.SIGNED_URL_TTL_SECONDS;
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(missing, ttl);
    if (error) throw error;
    for (const row of data || []) {
      if (!row.signedUrl) continue;
      cache.set(`${bucket}:${row.path}`, { url: row.signedUrl, exp: now + ttl * 1000 });
      out[row.path] = row.signedUrl;
    }
  }
  return out;
}

export async function signedUrl(bucket, path) {
  return (await signedUrls(bucket, [path]))[path] || null;
}
