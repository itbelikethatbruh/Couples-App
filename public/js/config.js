/* Couples App · runtime configuration
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * Fill these in after creating your Supabase project:
 *   Dashboard → Project Settings → API
 *
 * These values are PUBLIC by design. The publishable (anon) key only
 * grants what Row Level Security allows. NEVER put the service_role key
 * or any private key in this file.
 */
export const CONFIG = Object.freeze({
  SUPABASE_URL: 'https://wogffhgdixgrayowewnf.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvZ2ZmaGdkaXhncmF5b3dld25mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4ODUwMjcsImV4cCI6MjEwODQ2MTAyN30.1ektJPi5fLy2mcHjMdl1zgOm4UlyybkUNGCYbxEpZu0',
  // Leave empty: the server makes its own push keys and the app fetches
  // the public half. Only set this if you supply your own key pair.
  VAPID_PUBLIC_KEY: '',

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
