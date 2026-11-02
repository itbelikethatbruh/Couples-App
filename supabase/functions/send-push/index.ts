// Couples App · send-push Edge Function
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// POST {}  (Authorization: the signed-in user's JWT)
// Delivers the caller's pending alerts from push_outbox to their partner's
// devices. The app calls this when realtime shows a new outbox row.
// No secrets to set: the first call generates the signing keys (see
// _shared/push.ts). The app also calls this once to create them before
// a phone signs up for alerts.
import { serve, json, userClient } from '../_shared/http.ts';
import { flushFor } from '../_shared/push.ts';

serve(async (req) => {
  const { db } = await userClient(req);
  const r = await flushFor(db);
  return json({ sent: r.sent, gone: r.gone.length, failed: r.failed.length, configured: r.configured });
});
