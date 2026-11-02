// Couples App · universal-inbox Edge Function
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// POST { text?, url?, title?, note? }
// Auth, either:
//   Authorization: Bearer <user JWT>      (the app: paste box, Android share)
//   X-Inbox-Token: ci_…  or { token }     (iOS Shortcut, made in Settings)
//
// Files whatever was shared without AI or API keys:
//   TikTok link → TikTok vault · other link → a wishlist board ·
//   several lines → a checklist · one line → "Quick notes".
// Responds with { message, routed } so the Shortcut can show the message.
//
// Deploy with verify_jwt = false: Shortcut calls carry a token, not a JWT.
// Every request is still authenticated, by the JWT or by the token.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { serve, json, userClient, HttpError } from '../_shared/http.ts';
import { classify } from '../_shared/classify.ts';
import { readTikTok } from '../_shared/tiktok.ts';
import { unfurl } from '../_shared/unfurl.ts';
import { deliver, type PushJob } from '../_shared/push.ts';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

const PLACE: Record<string, string> = {
  amazon: 'your wishlist', restaurants: 'Restaurants', vacations: 'Vacations', events: 'Events'
};

serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const token = (req.headers.get('x-inbox-token') || str(body?.token, 80)).trim();
  const text = [str(body?.title, 300), str(body?.text, 20000)].filter(Boolean).join('\n').trim();
  const url = str(body?.url, 2048).trim();
  if (!text && !url) throw new HttpError(400, 'Nothing was shared');

  const c = classify(text, url);
  let payload: Record<string, unknown>;
  let message: string;
  if (c.kind === 'tiktok') {
    const t = await readTikTok(c.url);
    payload = { ...t, note: str(body?.note, 500) || c.note };
    message = 'Saved to the TikTok vault 🎬';
  } else if (c.kind === 'link') {
    let info: Awaited<ReturnType<typeof unfurl>> | null = null;
    try { info = await unfurl(c.url); } catch (err) { if (!(err instanceof HttpError) || err.status >= 500) throw err; }
    payload = {
      url: info?.url ?? c.url, title: info?.title ?? c.note ?? c.url, image_url: info?.image_url ?? null,
      price_cents: info?.price_cents ?? null, currency: info?.currency ?? 'USD', store: info?.store ?? null,
      asin: info?.asin ?? null, board_kind: c.board_kind
    };
    message = `Added to ${PLACE[c.board_kind]} 🎁`;
  } else if (c.kind === 'list') {
    payload = { title: c.title, list_kind: c.list_kind, items: c.items };
    message = `Made a list: ${c.title} (${c.items.length} items) 📝`;
  } else {
    if (!c.body) throw new HttpError(400, 'Nothing was shared');
    payload = { body: c.body };
    message = 'Added to Quick notes 📝';
  }

  if (token) {
    // Shortcut path: the token is the login. Uses only the public anon key;
    // the database checks the token and acts as its owner.
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await anon.rpc('inbox_submit', {
      p_token: token, p_kind: c.kind, p_payload: payload, p_raw_text: text || null, p_raw_url: url || null
    });
    if (error) throw new HttpError(error.code === '28000' ? 401 : 400, error.message);
    // Nobody's app is open to flush alerts for this share, so send them here.
    const jobs = await anon.rpc('inbox_claim_push', { p_token: token });
    if (!jobs.error) await deliver((jobs.data ?? []) as PushJob[]);
    if ((data as { duplicate?: boolean })?.duplicate) message = 'Already in the TikTok vault 🎬';
    return json({ message, routed: data });
  }

  const { db } = await userClient(req);
  const source = body?.source === 'share_sheet' ? 'share_sheet' : 'paste';
  const { data, error } = await db.rpc('inbox_save', {
    p_source: source, p_kind: c.kind, p_payload: payload, p_raw_text: text || null, p_raw_url: url || null
  });
  if (error) throw new HttpError(400, error.message);
  if ((data as { duplicate?: boolean })?.duplicate) message = 'Already in the TikTok vault 🎬';
  return json({ message, routed: data });
});
