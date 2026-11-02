// Couples App · unfurl-link Edge Function
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// POST { url }  (Authorization: the signed-in user's JWT)
// → { url, title, image_url, price_cents, currency, store, asin, blocked }
//
// Only signed-in users can call this, so it is not an open proxy. The
// scraping itself lives in ../_shared/unfurl.ts.
import { serve, json, userClient, HttpError } from '../_shared/http.ts';
import { unfurl } from '../_shared/unfurl.ts';

serve(async (req) => {
  await userClient(req);                           // signed-in users only
  const body = await req.json().catch(() => ({}));
  const input = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!input || input.length > 2048) throw new HttpError(400, 'Paste a link first');
  return json(await unfurl(input));
});
