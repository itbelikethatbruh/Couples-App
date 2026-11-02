# Us: a private, real-time space for two

A cloud-synced Progressive Web App for one couple. It installs to the home screen on iPhone and Android, syncs live through Supabase, and runs entirely on free tiers.

> **License:** proprietary, All Rights Reserved. The code is public so people can see the work. That does not give anyone permission to copy, deploy, or reuse it. See [LICENSE](LICENSE).

## What's in Phase 1

| Area | What it does |
| --- | --- |
| **Database** (`supabase/schema.sql`) | 42 tables covering all six modules, Row Level Security on every one, Realtime publication, and four private Storage buckets. Re-running the script is safe. |
| **Two-seat identity** | Each partner has their own Supabase login. A couple holds exactly two seats (`partner_a`, `partner_b`), enforced by a unique constraint. The invite code is burned once the second partner joins, so nobody else can get in. Display names are set in the app, not in code. |
| **Liquid glass UI** | Obsidian `#050505` base, `backdrop-filter: blur(24px) saturate(180%)` glass, 1px specular borders, neon-rose and electric-indigo light, spring animations. Draws edge to edge under the Dynamic Island and home bar. |
| **3D depth engine** | Four parallax planes (wallpaper, light orbs, UI, overlays) driven by the phone's gyroscope or the mouse. Cards tilt in 3D with a specular highlight that follows your finger. Tab changes rotate in 3D. Orbital 3D emblem on the lock screen. Particle bursts with perspective. Everything turns off with *Reduce motion*. |
| **Wallpaper engine** | Upload a photo globally or for one tab. Dark Glass Tint (0 to 95%) and Blur (0 to 40px) sliders. While one partner drags a slider, the other partner's screen changes live. Photos are resized on the phone before upload. |
| **App lock** | Face ID on iPhone, fingerprint on Pixel (WebAuthn), and a 4-digit PIN fallback. Auto-locks after a chosen time in the background. |
| **Bottom dock** | Floating glass dock with a sliding liquid indicator and haptic feedback. |
| **Partner switcher** | Top-bar toggle that brings either partner's cards to the front. It changes *focus*, never who you are signed in as. |
| **Live Spark core** | Both partners' status, mood, and social battery update in real time. *Send love* and *Thinking of you* trigger a heart burst on the other phone. |
| **PWA** | `manifest.json` (standalone, maskable icons, shortcuts, Android share target) and `sw.js` (app-shell cache, Web Push, notification routing). |

## What's in Phase 2

| Area | What it does |
| --- | --- |
| **Blind daily question** | 80 prompts across Fun, Deep, Spicy 🔥 and Future. Your partner's answer never reaches your phone until you've both answered (RLS), then both unlock at once with a comment thread. You can deal up to 3 cards a day. |
| **Voice notes** | Record up to 15 seconds (AAC on iPhone, Opus on Android), preview, send. "New" badge until your partner plays it. |
| **Polaroid calendar** | One photo each per day forms the day's dual polaroid. A month grid shows every day you kept. Photos are resized on the phone and stored privately. |
| **Dinner swiper** | Swipe deck of home meals, restaurants, and anything on your Restaurants wishlist. When you both swipe right on the same card, both phones celebrate at once and you can lock it into the calendar. Pork dishes are included; a **Hide pork** switch in Settings filters them for both of you. |
| **Bounty board + Love Coins** | Post chores with a coin reward. Claim → done → your partner approves → coins are minted by the database. You can't approve your own task or skip steps. |
| **Coupon wallet** | Spend coins on coupons (8 defaults, add your own). The database checks your balance. Your partner marks them fulfilled. |
| **Date night roulette** | 3D wheel of date ideas with weights. A spin on one phone plays on both, then you can lock it into the calendar. |
| **Partner Vault** | Sizes, go-to orders, favorites, allergies and diet, travel preferences, and more, for each of you. The top switcher picks whose vault is open. Either of you can fill in either vault. Live countdowns to birthdays, anniversaries and trips. |

## What's in Phase 3

| Area | What it does |
| --- | --- |
| **Settle up** | One number: who owes whom, from split expenses and past settlements, on a 3D seesaw that tips toward whoever's ahead. One tap records a settlement for the full amount. |
| **50/30/20 rings** | Needs, Wants and Savings as glowing concentric rings for any month, fed by both expenses and paid bills. Set your combined take-home pay and your own split. Rings glow red when a bucket goes over. |
| **Bills** | Recurring bills (weekly, monthly, yearly, one-time) with overdue, today and soon colors, autopay tags and who pays. "Paid ✓" logs the payment and rolls the due date forward in one database call (Jan 31 → Feb 28 → Mar 31). Undo the latest payment if you tapped by mistake. |
| **Spending log** | Category bar, joint / 50-50 / "they owe it all" splits, and line items. |
| **Savings jars** | 3D glass jars that fill as you save, with a "$X/mo to hit it" pace when you set a date. Deposits are atomic, so two quick taps on two phones both count. |
| **Smart Wishlists** | A personal Amazon list each, shared Restaurants / Vacations / Events boards, and your own lists. Paste a link and the `unfurl-link` Edge Function fills in the title, photo and price (Amazon, plus any store with standard product tags). Priority tags: Need, Want, Treat, Dream. Restaurants you add show up in the dinner swiper. |
| **Surprise Lock** | On your partner's list, tap "🔒 I'll get it". The item is veiled for you, and your partner never sees the claim, enforced by the database, not the app. |

## Honest limits

- **The app lock protects the screen, not the data.** WebAuthn and the PIN are checked on the device. Your data is protected on the server by Supabase Auth and RLS. The lock stops someone who picks up an unlocked phone. The public key is saved to `webauthn_credentials`, so a later Edge Function could verify server-side if you want that.
- **A 4-digit PIN is weak against someone holding the phone with developer tools.** It is hashed (PBKDF2, 210k rounds) with growing delays after wrong tries, but 10,000 combinations is a small space.
- **Face ID / fingerprint is tied to the exact web address.** If you move from `*.pages.dev` to your own domain, set it up again.
- **iPhone push notifications only work from the home-screen app** (iOS 16.4+), and permission has to come from a tap. In a regular Safari tab, push does not exist.
- **Voice notes from iPhone play on Android Chrome and vice versa** on current OS versions. Very old Android WebViews may not play AAC.
- **Push alerts for answers, voice notes, matches and coupons arrive in Phase 4** with the `send-push` Edge Function. Until then, the other phone sees them live while the app is open.
- **iPhone haptics:** Safari has no vibration API. The app uses an iOS 18 switch-control trick for a light tap. On older iOS, you get the visual press animation only.
- **Amazon often blocks automated page reads.** When it does, the link scraper keeps the cleaned link and a title from the URL, but no photo or price. Type those in, or paste the link again later.
- **Money is tracked, not moved.** "Settle up" and bills record what you did in your bank app; nothing connects to a bank.
- **Free-tier limits** (check current numbers on the Supabase pricing page): projects pause after about a week with no activity; there is a 1 GB Storage cap and a cap on the built-in email sender. Use password sign-in day to day so you don't hit the email cap.

## Setup

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor:** paste all of `supabase/schema.sql` and run it, then do the same with `supabase/phase2.sql` and `supabase/phase3.sql`, in that order. Each file is safe to run again.
3. **Authentication → Sign In / Providers → Email:** leave Email on. For a two-person app, it's fine to turn off *Confirm email* so sign-up logs you straight in.
4. **Authentication → Email Templates → Magic Link:** add `{{ .Token }}` to the template body so the *Email me a code* option sends a 6-digit code. The app does not use magic links, because on iPhone they open in Safari, not in the installed app.
5. **Authentication → URL Configuration:** set *Site URL* to your deployed address.
6. **Project Settings → API:** copy the Project URL and the anon/publishable key.
7. **Edge Function** (needs the [Supabase CLI](https://supabase.com/docs/guides/cli)):
   ```sh
   supabase link --project-ref <your-ref>
   supabase functions deploy unfurl-link
   ```
   It runs as the signed-in user, so RLS still applies. It never uses the `service_role` key, and it needs no API keys.

### 2. Configure the app

Edit `public/js/config.js`:

```js
SUPABASE_URL: 'https://<your-ref>.supabase.co',
SUPABASE_ANON_KEY: '<anon or publishable key>',
VAPID_PUBLIC_KEY: '<from: npx web-push generate-vapid-keys>'
```

These three values are meant to be public. **Never** put the `service_role` key, or the VAPID *private* key in the frontend. They go in Supabase Edge Function secrets. See `.env.example`.

### 3. Deploy (free)

**Cloudflare Pages:** connect the repo, leave the build command empty, set the output directory to `public`. Security headers come from `public/_headers`.

**Vercel:** import the repo, framework *Other*, no build command. `vercel.json` sets the output directory and headers.

### 4. Install on each phone

- **iPhone (Safari):** open the site → Share → *Add to Home Screen* → open it from the icon. Then Settings ⚙ → turn on Notifications and Face ID.
- **Pixel (Chrome):** open the site → ⋮ → *Install app*. Then Settings ⚙ → turn on Notifications and Fingerprint.

### 5. Pair

One partner taps **Create our space** and shares the 8-character code. The other signs in on their own phone and taps **Join with code**. The first phone updates the moment they join.

## Project layout

```
public/
  index.html            app shell
  manifest.json         PWA manifest
  sw.js                 service worker (cache + Web Push)
  _headers              Cloudflare Pages security headers
  css/app.css           liquid glass design system + 3D depth
  js/
    app.js              boot sequence, top bar, toasts
    config.js           public runtime config (placeholders)
    store.js            reactive state engine
    supabase.js         client
    auth.js             sign-in, pairing, waiting room
    realtime.js         one channel: DB changes, presence, broadcast
    wallpaper.js        wallpaper engine
    lock.js             WebAuthn + PIN lock
    push.js             Web Push subscription
    router.js           hash router + dock
    fx.js               parallax, 3D tilt, particle bursts
    ui.js               DOM builder, icons, haptics
    media.js            image compression, uploads, signed URLs
    sheet.js            bottom sheets, forms, celebration modal
    spark/              Spark Hub modules (question, voice, memories, dinner, bounty, coupons, roulette)
    money/              settle-up, budget rings, bills, spending, savings jars
    views/              spark, vault, money, wishlist, settings, placeholders
  icons/                app icons
supabase/schema.sql     database, RLS, realtime, storage
supabase/phase2.sql     question deck, meal seeds, Spark Hub functions
supabase/phase3.sql     money + wishlist guards, bill/fund/budget/settle functions
supabase/functions/     Edge Functions: unfurl-link (link scraper)
```

No build step and no npm dependencies. `supabase-js` is loaded as a pinned ES module from jsDelivr.

## Security model

- Every shared row has `couple_id`, filled in by the database from the signed-in user, never sent by the client. RLS compares it on every read and write.
- `profiles.couple_id` and `slot` can only change through the `create_couple` / `join_couple` functions. Column-level grants stop clients from editing them directly.
- **Blind daily answers:** your partner's answer is hidden by RLS until you've both answered, including in live updates.
- **Surprise Lock:** a "secretly purchased" claim is visible only to the person who made it. You can't claim items on your own list.
- **Money rows** are checked by triggers: who paid and who's responsible must belong to your couple, and bill payments can't be edited after the fact.
- **Link scraper** refuses private, local and raw-IP addresses, so it can't be pointed at internal services.
- **Love coins** are written only by database triggers (when the *other* partner approves a task, or when a coupon is redeemed with enough balance).
- Storage paths are `{couple_id}/{user_id}/…`. You can read your couple's files, and only write or delete your own.

## Roadmap

- **Phase 2 (done):** Spark Hub and Partner Vault.
- **Phase 3 (done):** Money (bills, 50/30/20 rings, sinking funds, settle-up) and Smart Wishlists (link scraper, Surprise Lock).
- **Phase 4:** TikTok vault, notes, Edge Functions (`parse-tiktok`, `universal-inbox`, `send-push`), iOS Shortcut guide, Scriptable widget.

The app needs no paid or third-party API keys. Features that would (AI receipt scanning, AI note sorting, Ticketmaster events) were left out on purpose.

---

Copyright (c) 2026 itbelikethatbruh. All Rights Reserved.
