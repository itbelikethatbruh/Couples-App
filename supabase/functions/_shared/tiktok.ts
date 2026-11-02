// Couples App · TikTok link reader (no API key)
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// Accepts any TikTok share link (tiktok.com/@user/video/ID, vm./vt. short
// links, m.tiktok.com), follows redirects only within TikTok's own hosts,
// and reads title / author / thumbnail from TikTok's public oEmbed endpoint.
import { HttpError } from './http.ts';

export type TikTokInfo = {
  video_id: string;
  share_url: string;
  title: string | null;
  author_name: string | null;
  thumbnail_url: string | null;
};

const TIKTOK_HOST = /(^|\.)tiktok\.com$/i;
const VIDEO_ID = /\/(?:video|v|photo)\/(\d{15,21})(?:[/?#.]|$)/;

export function isTikTokUrl(raw: string): boolean {
  try { return TIKTOK_HOST.test(new URL(raw).hostname); } catch { return false; }
}

async function resolveId(start: URL): Promise<{ id: string; url: URL }> {
  let url = start;
  for (let hop = 0; hop < 5; hop++) {
    const m = VIDEO_ID.exec(url.pathname);
    if (m) return { id: m[1], url };
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' }
    });
    const loc = res.headers.get('location');
    await res.body?.cancel();
    if (!loc) break;
    const next = new URL(loc, url);
    if (next.protocol !== 'https:' || !TIKTOK_HOST.test(next.hostname)) break;
    url = next;
  }
  throw new HttpError(422, 'Could not find the video in that TikTok link');
}

export async function readTikTok(raw: string): Promise<TikTokInfo> {
  let start: URL;
  try { start = new URL(raw.trim()); } catch { throw new HttpError(400, 'That is not a valid link'); }
  if (start.protocol !== 'https:' && start.protocol !== 'http:') throw new HttpError(400, 'That is not a TikTok link');
  start.protocol = 'https:';
  if (!TIKTOK_HOST.test(start.hostname)) throw new HttpError(400, 'That is not a TikTok link');

  const { id, url } = await resolveId(start);
  const author = /\/@([^/]+)/.exec(url.pathname)?.[1] ?? 'tiktok';
  const canonical = `https://www.tiktok.com/@${author}/video/${id}`;

  let meta: Record<string, unknown> = {};
  try {
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(canonical)}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) meta = await res.json();
    else await res.body?.cancel();
  } catch { /* oEmbed is optional: the video still plays from its id */ }

  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const thumb = str(meta.thumbnail_url, 2000);
  return {
    video_id: id,
    share_url: canonical,
    title: str(meta.title, 300),
    author_name: str(meta.author_name, 120) ?? (author !== 'tiktok' ? author : null),
    thumbnail_url: thumb && thumb.startsWith('https://') ? thumb : null
  };
}
