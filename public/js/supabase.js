/* Couples App · Supabase client
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { CONFIG, isConfigured } from './config.js';

export const supabase = isConfigured()
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // We use 6-digit email codes, not magic links: on iOS a magic link opens
        // in Safari, whose storage is separate from the home-screen app.
        detectSessionInUrl: false,
        storageKey: 'us.auth'
      },
      realtime: { params: { eventsPerSecond: 20 } }
    })
  : null;

/** Throw a readable error from a Supabase { data, error } response. */
export function unwrap({ data, error }) {
  if (error) {
    const msg = error.message || error.error_description || 'Something went wrong';
    const e = new Error(msg);
    e.code = error.code;
    throw e;
  }
  return data;
}
