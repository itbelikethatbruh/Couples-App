// Couples App · Web Push delivery
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// Delivers alerts that the database already wrote to push_outbox (see
// phase4.sql). Text never comes from a client. VAPID keys are generated
// for this app (no third-party account) and kept as function secrets.
import webpush from 'npm:web-push@3.6.7';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export type PushJob = {
  job_id: string; job_kind: string; job_title: string; job_body: string | null; job_url: string; job_tag: string | null;
  sub_endpoint: string; sub_p256dh: string; sub_auth: string;
};

let configured: boolean | null = null;
function configure(): boolean {
  if (configured !== null) return configured;
  const pub = Deno.env.get('VAPID_PUBLIC_KEY');
  const priv = Deno.env.get('VAPID_PRIVATE_KEY');
  const subject = Deno.env.get('VAPID_SUBJECT') || 'https://github.com/itbelikethatbruh/Couples-App';
  configured = Boolean(pub && priv);
  if (configured) webpush.setVapidDetails(subject, pub!, priv!);
  return configured;
}

/** Sends every job; returns endpoints grouped by outcome for push_report(). */
export async function deliver(jobs: PushJob[]) {
  const ok: string[] = [];
  const gone: string[] = [];
  const failed: string[] = [];
  if (!jobs.length) return { sent: 0, ok, gone, failed, configured: configure() };
  if (!configure()) return { sent: 0, ok, gone, failed, configured: false };

  await Promise.all(jobs.map(async (j) => {
    const payload = JSON.stringify({ title: j.job_title, body: j.job_body ?? '', kind: j.job_kind, url: j.job_url, tag: j.job_tag ?? undefined });
    try {
      await webpush.sendNotification(
        { endpoint: j.sub_endpoint, keys: { p256dh: j.sub_p256dh, auth: j.sub_auth } },
        payload,
        { TTL: 60 * 60 * 6, urgency: 'high', timeout: 8000 }
      );
      ok.push(j.sub_endpoint);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) gone.push(j.sub_endpoint);
      else { failed.push(j.sub_endpoint); console.warn('[push] failed', status, (err as Error).message); }
    }
  }));
  return { sent: ok.length, ok, gone, failed, configured: true };
}

/** Claims the caller's pending alerts, sends them, reports results. */
export async function flushFor(db: SupabaseClient) {
  const { data, error } = await db.rpc('claim_push_jobs');
  if (error) throw new Error(error.message);
  const result = await deliver((data ?? []) as PushJob[]);
  if (result.ok.length || result.gone.length || result.failed.length) {
    await db.rpc('push_report', { p_ok: result.ok, p_gone: result.gone, p_failed: result.failed });
  }
  return result;
}
