// Couples App · send-push Edge Function
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// POST {}  (Authorization: the signed-in user's JWT)
// Delivers the caller's pending alerts from push_outbox to their partner's
// devices. The app calls this when realtime shows a new outbox row.
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (optional).
import { serve, json, userClient } from '../_shared/http.ts';
import { flushFor } from '../_shared/push.ts';

serve(async (req) => {
  const { db } = await userClient(req);
  const r = await flushFor(db);
  return json({ sent: r.sent, gone: r.gone.length, failed: r.failed.length, configured: r.configured });
});
