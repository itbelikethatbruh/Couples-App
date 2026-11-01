/* Couples App · runtime configuration
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Fill these in after creating your Supabase project:
 *   Dashboard → Project Settings → API
 *
 * These three values are PUBLIC by design. The publishable (anon) key only
 * grants what Row Level Security allows, and a VAPID *public* key is meant
 * to be shipped to browsers. NEVER put the service_role key, the VAPID
 * private key, or any LLM API key in this file. Those belong in Supabase
 * Edge Function secrets (Phase 4).
 */
export const CONFIG = Object.freeze({
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-SUPABASE-ANON-OR-PUBLISHABLE-KEY',
  VAPID_PUBLIC_KEY: 'YOUR-VAPID-PUBLIC-KEY',

  APP_NAME: 'Us',
  // How long the app may sit in the background before the biometric/PIN lock re-engages.
  DEFAULT_AUTO_LOCK_MINUTES: 5,
  // Wallpaper uploads are downscaled client-side to stay inside the free 1 GB storage tier.
  WALLPAPER_MAX_EDGE_PX: 2400,
  WALLPAPER_JPEG_QUALITY: 0.86,
  SIGNED_URL_TTL_SECONDS: 60 * 60 * 24 * 7
});

export const isConfigured = () =>
  !CONFIG.SUPABASE_URL.includes('YOUR-PROJECT-REF') &&
  !CONFIG.SUPABASE_ANON_KEY.startsWith('YOUR-');
