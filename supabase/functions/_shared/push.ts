// Couples App · Web Push delivery
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// Delivers alerts that the database already wrote to push_outbox (see
// phase4.sql). Text never comes from a client.
//
// Signing (VAPID) keys need no account and no setup: the first time this
// runs it generates a key pair and stores it in public.push_vapid_keys,
// a table only the service role can read. Browsers get the public half
// through the push_public_key() RPC. If VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY are set as function secrets, those win instead.
import webpush from 'npm:web-push@3.6.7';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export type PushJob = {
  job_id: string; job_kind: string; job_title: string; job_body: string | null; job_url: string; job_tag: string | null;
  sub_endpoint: string; sub_p256dh: string; sub_auth: string;
};

type KeyPair = { publicKey: string; privateKey: string };

async function storedKeys(): Promise<KeyPair | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !service) return null;
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const read = async () => {
    const { data, error } = await admin.from('push_vapid_keys').select('public_key,private_key').eq('id', true).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? { publicKey: data.public_key as string, privateKey: data.private_key as string } : null;
  };
  const existing = await read();
  if (existing) return existing;
  // First run: make a pair. If two calls race, the first insert wins and
  // both read back the same row.
  const fresh = webpush.generateVAPIDKeys();
  const { error } = await admin.from('push_vapid_keys')
    .upsert({ id: true, public_key: fresh.publicKey, private_key: fresh.privateKey }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  return await read();
}

let ready: Promise<boolean> | null = null;
/** Loads (or creates) the signing keys once per function instance. */
export function configure(): Promise<boolean> {
  if (ready) return ready;
  ready = (async () => {
    const subject = Deno.env.get('VAPID_SUBJECT') || 'https://github.com/itbelikethatbruh/Couples-App';
    const envPub = Deno.env.get('VAPID_PUBLIC_KEY');
    const envPriv = Deno.env.get('VAPID_PRIVATE_KEY');
    const keys = envPub && envPriv ? { publicKey: envPub, privateKey: envPriv } : await storedKeys();
    if (!keys) return false;
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    return true;
  })().catch((err) => {
    console.warn('[push] key setup failed', (err as Error).message);
    ready = null;              // try again on the next call
    return false;
  });
  return ready;
}

/** Sends every job; returns endpoints grouped by outcome for push_report(). */
export async function deliver(jobs: PushJob[]) {
  const ok: string[] = [];
  const gone: string[] = [];
  const failed: string[] = [];
  const configured = await configure();
  if (!jobs.length || !configured) return { sent: 0, ok, gone, failed, configured };

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
  // Keys first, so alerts are never marked sent when they can't be signed.
  if (!(await configure())) return { sent: 0, ok: [], gone: [], failed: [], configured: false };
  const { data, error } = await db.rpc('claim_push_jobs');
  if (error) throw new Error(error.message);
  const result = await deliver((data ?? []) as PushJob[]);
  if (result.ok.length || result.gone.length || result.failed.length) {
    await db.rpc('push_report', { p_ok: result.ok, p_gone: result.gone, p_failed: result.failed });
  }
  return result;
}
