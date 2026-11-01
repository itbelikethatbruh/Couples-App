-- =====================================================================
--  Couples App · Supabase schema (Phase 1 foundation)
--  Copyright (c) 2026. All Rights Reserved. See LICENSE.
--
--  Run in: Supabase Dashboard → SQL Editor → paste → Run.
--  The script is idempotent: re-running it is safe.
--
--  Identity model
--  --------------
--  * Every person signs in with Supabase Auth (one auth.users row each).
--  * A "couple" is a private space that holds EXACTLY two profiles.
--    The two seats are the enum slots partner_a / partner_b, enforced by
--    UNIQUE (couple_id, slot). Display names live in profiles and are
--    editable in the app; nothing here hardcodes a person's name.
--  * Every shared table carries couple_id with a DEFAULT of
--    public.my_couple_id(), so clients never send it and can never write
--    into another couple's space. RLS checks it on every row.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Extensions & enums
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

do $$ begin
  create type public.partner_slot as enum ('partner_a', 'partner_b');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.question_category as enum ('fun', 'deep', 'spicy', 'future');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ping_kind as enum (
    'love', 'thinking_of_you', 'need_cuddles', 'need_hype', 'custom'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.expense_split as enum (
    'joint',       -- paid from a joint account; nobody owes anybody
    'split_even',  -- payer covered it, the other partner owes half
    'full_owed'    -- payer covered it, the other partner owes all of it
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.budget_bucket as enum ('needs', 'wants', 'savings');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.wishlist_priority as enum ('must_have', 'need_soon', 'treat');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.wishlist_kind as enum ('amazon', 'restaurants', 'vacations', 'events', 'custom');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 1. Generic helpers
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 2. Couples & profiles (the 2-seat identity core)
-- ---------------------------------------------------------------------
create table if not exists public.couples (
  id           uuid primary key default gen_random_uuid(),
  name         text not null default 'Us' check (char_length(name) between 1 and 40),
  invite_code  text unique default upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 8)),
  timezone     text not null default 'America/New_York',
  home_city    text not null default 'Atlanta',
  home_state   text not null default 'GA',
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  couple_id          uuid references public.couples (id) on delete set null,
  slot               public.partner_slot,
  display_name       text not null default 'Partner' check (char_length(display_name) between 1 and 32),
  avatar_emoji       text not null default '✨' check (char_length(avatar_emoji) <= 8),
  accent             text not null default '#ff2d78' check (accent ~ '^#[0-9a-fA-F]{6}$'),
  mood_emoji         text check (char_length(mood_emoji) <= 8),
  status_kind        text check (status_kind in (
                       'available', 'work', 'gym', 'thinking_of_you', 'driving',
                       'sleeping', 'low_battery', 'need_hype', 'custom')),
  status_text        text check (char_length(status_text) <= 60),
  social_battery     smallint check (social_battery between 0 and 100),
  status_updated_at  timestamptz,
  last_seen_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Exactly two seats per couple: the enum has two values and each is unique.
  constraint profiles_one_seat_per_slot unique (couple_id, slot),
  constraint profiles_slot_requires_couple check ((couple_id is null) = (slot is null))
);

-- Fast lookups used by every RLS policy.
create index if not exists profiles_couple_idx on public.profiles (couple_id);

-- Caller's couple. SECURITY DEFINER so policies on profiles can use it
-- without recursing into profiles' own RLS.
create or replace function public.my_couple_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select couple_id from public.profiles where id = auth.uid()
$$;

create or replace function public.my_partner_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select p.id
  from public.profiles p
  where p.couple_id = (select couple_id from public.profiles where id = auth.uid())
    and p.id <> auth.uid()
  limit 1
$$;

-- Auto-create a bare profile whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(left(new.raw_user_meta_data ->> 'display_name', 32), ''), 'Partner')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Create a new couple space and take seat partner_a.
create or replace function public.create_couple(p_display_name text, p_couple_name text default 'Us')
returns public.couples language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_couple public.couples;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if exists (select 1 from public.profiles where id = v_uid and couple_id is not null) then
    raise exception 'already in a couple' using errcode = 'P0001';
  end if;

  insert into public.couples (name, created_by)
  values (coalesce(nullif(trim(p_couple_name), ''), 'Us'), v_uid)
  returning * into v_couple;

  insert into public.profiles (id, couple_id, slot, display_name)
  values (v_uid, v_couple.id, 'partner_a', coalesce(nullif(trim(p_display_name), ''), 'Partner'))
  on conflict (id) do update
    set couple_id = excluded.couple_id,
        slot = excluded.slot,
        display_name = excluded.display_name;

  insert into public.wallpaper_settings (couple_id, scope, updated_by)
  values (v_couple.id, 'global', v_uid)
  on conflict do nothing;

  insert into public.budget_settings (couple_id) values (v_couple.id) on conflict do nothing;

  return v_couple;
end $$;

-- Join an existing couple with its invite code and take the free seat.
create or replace function public.join_couple(p_invite_code text, p_display_name text)
returns public.couples language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_couple public.couples;
  v_taken public.partner_slot[];
  v_slot public.partner_slot;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if exists (select 1 from public.profiles where id = v_uid and couple_id is not null) then
    raise exception 'already in a couple' using errcode = 'P0001';
  end if;

  -- Row lock serialises two people racing for the last seat.
  select * into v_couple
  from public.couples
  where invite_code = upper(trim(p_invite_code))
  for update;

  if v_couple.id is null then raise exception 'invalid invite code' using errcode = 'P0002'; end if;

  select coalesce(array_agg(slot), '{}') into v_taken
  from public.profiles where couple_id = v_couple.id;

  if array_length(v_taken, 1) >= 2 then
    raise exception 'this space already has two partners' using errcode = 'P0003';
  end if;

  v_slot := case when 'partner_a' = any(v_taken) then 'partner_b' else 'partner_a' end;

  insert into public.profiles (id, couple_id, slot, display_name)
  values (v_uid, v_couple.id, v_slot, coalesce(nullif(trim(p_display_name), ''), 'Partner'))
  on conflict (id) do update
    set couple_id = excluded.couple_id,
        slot = excluded.slot,
        display_name = excluded.display_name;

  -- The space is now full: burn the invite code so it cannot be reused.
  update public.couples set invite_code = null where id = v_couple.id returning * into v_couple;
  return v_couple;
end $$;

-- ---------------------------------------------------------------------
-- 3. Device & security tables (owner-only)
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  platform      text check (platform in ('ios', 'android', 'desktop', 'other')),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  failed_count  smallint not null default 0
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Public keys of platform authenticators (Face ID / fingerprint).
-- Phase 1 uses WebAuthn as a LOCAL unlock gate. These rows exist so an Edge
-- Function can later verify assertions server-side without a migration.
create table if not exists public.webauthn_credentials (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  credential_id  text not null unique,           -- base64url rawId
  public_key     text,                           -- base64url SPKI (when the browser exposes it)
  alg            integer,                        -- COSE alg, e.g. -7 (ES256)
  transports     text[] not null default '{}',
  device_label   text check (char_length(device_label) <= 60),
  sign_count     bigint not null default 0,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);
create index if not exists webauthn_credentials_user_idx on public.webauthn_credentials (user_id);

-- Long-lived tokens for the iOS Shortcut webhook (Phase 4). Only the
-- SHA-256 hash is stored; the plaintext is shown once at creation.
create table if not exists public.inbox_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token_hash    text not null unique,
  label         text not null default 'iOS Shortcut' check (char_length(label) <= 40),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists inbox_tokens_user_idx on public.inbox_tokens (user_id);

create or replace function public.create_inbox_token(p_label text default 'iOS Shortcut')
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_plain text := 'ci_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  insert into public.inbox_tokens (user_id, token_hash, label)
  values (auth.uid(), encode(extensions.digest(v_plain, 'sha256'), 'hex'), coalesce(p_label, 'iOS Shortcut'));
  return v_plain;
end $$;

-- ---------------------------------------------------------------------
-- 4. Wallpaper engine
-- ---------------------------------------------------------------------
create table if not exists public.wallpaper_settings (
  couple_id     uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  scope         text not null check (scope in ('global', 'lock', 'spark', 'vault', 'money', 'wishlist', 'discover')),
  storage_path  text,                                        -- object path in bucket "wallpapers"
  tint          smallint not null default 55 check (tint between 0 and 95),   -- % of obsidian overlay
  blur          smallint not null default 0  check (blur between 0 and 40),   -- px
  inherit       boolean not null default true,               -- tab scopes: fall back to global when true
  updated_by    uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (couple_id, scope)
);

-- ---------------------------------------------------------------------
-- 5. Module 1 · Spark Hub
-- ---------------------------------------------------------------------
create table if not exists public.love_pings (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  sender_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        public.ping_kind not null default 'love',
  message     text check (char_length(message) <= 140),
  seen_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists love_pings_couple_created_idx on public.love_pings (couple_id, created_at desc);

create table if not exists public.daily_questions (
  id          bigint generated always as identity primary key,
  category    public.question_category not null,
  prompt      text not null unique check (char_length(prompt) between 5 and 300),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.question_assignments (
  id           uuid primary key default gen_random_uuid(),
  couple_id    uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  question_id  bigint not null references public.daily_questions (id) on delete restrict,
  for_date     date not null,
  created_at   timestamptz not null default now(),
  unique (couple_id, for_date, question_id)
);

create table if not exists public.question_answers (
  id             uuid primary key default gen_random_uuid(),
  couple_id      uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  assignment_id  uuid not null references public.question_assignments (id) on delete cascade,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  answer         text not null check (char_length(answer) between 1 and 2000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (assignment_id, user_id)
);

-- True once both partners have answered: the blur unlocks for both at once.
create or replace function public.question_unlocked(p_assignment_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select count(distinct user_id) >= 2
  from public.question_answers
  where assignment_id = p_assignment_id
$$;

create table if not exists public.question_comments (
  id             uuid primary key default gen_random_uuid(),
  couple_id      uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  assignment_id  uuid not null references public.question_assignments (id) on delete cascade,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body           text not null check (char_length(body) between 1 and 1000),
  created_at     timestamptz not null default now()
);

create table if not exists public.voice_notes (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  created_by    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  storage_path  text not null,                              -- bucket "voice-notes"
  duration_ms   integer not null check (duration_ms between 300 and 16000),
  mime_type     text not null,
  transcript    text,
  listened_at   timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists public.memories (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  created_by    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  for_date      date not null default current_date,
  storage_path  text not null,                              -- bucket "memories"
  caption       text check (char_length(caption) <= 280),
  created_at    timestamptz not null default now(),
  unique (couple_id, for_date, created_by)                  -- one polaroid each per day = the dual photo
);

-- Dinner matcher
create table if not exists public.meal_options (
  id                uuid primary key default gen_random_uuid(),
  couple_id         uuid references public.couples (id) on delete cascade, -- NULL = global seed card
  kind              text not null check (kind in ('home', 'restaurant')),
  title             text not null check (char_length(title) between 1 and 120),
  cuisine           text,
  image_url         text,
  wishlist_item_id  uuid,                                    -- FK added after wishlist_items exists
  is_pork_free      boolean not null default true,     -- powers the optional 'Hide pork' filter
  active            boolean not null default true,
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  created_at        timestamptz not null default now()
);

create table if not exists public.dinner_swipes (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  option_id   uuid not null references public.meal_options (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  for_date    date not null default current_date,
  liked       boolean not null,
  created_at  timestamptz not null default now(),
  unique (option_id, user_id, for_date)
);

create table if not exists public.dinner_matches (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null references public.couples (id) on delete cascade,
  option_id   uuid not null references public.meal_options (id) on delete cascade,
  for_date    date not null,
  created_at  timestamptz not null default now(),
  unique (couple_id, option_id, for_date)
);

create or replace function public.detect_dinner_match()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.liked and exists (
    select 1 from public.dinner_swipes s
    where s.option_id = new.option_id
      and s.for_date = new.for_date
      and s.couple_id = new.couple_id
      and s.user_id <> new.user_id
      and s.liked
  ) then
    insert into public.dinner_matches (couple_id, option_id, for_date)
    values (new.couple_id, new.option_id, new.for_date)
    on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists dinner_swipes_match on public.dinner_swipes;
create trigger dinner_swipes_match
  after insert or update of liked on public.dinner_swipes
  for each row execute function public.detect_dinner_match();

-- Bounty board, coins, coupons, roulette
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 120),
  details       text check (char_length(details) <= 1000),
  reward_coins  integer not null default 10 check (reward_coins between 0 and 1000),
  status        text not null default 'open' check (status in ('open', 'claimed', 'done', 'approved')),
  created_by    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  claimed_by    uuid references auth.users (id) on delete set null,
  approved_by   uuid references auth.users (id) on delete set null,
  due_at        timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Append-only coin ledger. Clients can read it; only triggers write it.
create table if not exists public.coin_ledger (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null references public.couples (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  delta       integer not null check (delta <> 0),
  reason      text not null,
  ref_table   text,
  ref_id      uuid,
  created_at  timestamptz not null default now(),
  unique (ref_table, ref_id, user_id)
);

create table if not exists public.coupons (
  id           uuid primary key default gen_random_uuid(),
  couple_id    uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 80),
  emoji        text not null default '🎟️',
  description  text check (char_length(description) <= 280),
  cost_coins   integer not null check (cost_coins between 1 and 10000),
  active       boolean not null default true,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);

create table if not exists public.coupon_redemptions (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  coupon_id     uuid not null references public.coupons (id) on delete cascade,
  redeemed_by   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  cost_coins    integer not null default 0,
  status        text not null default 'pending' check (status in ('pending', 'fulfilled', 'cancelled')),
  fulfilled_at  timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists public.date_ideas (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 120),
  emoji       text not null default '🎲',
  category    text,
  weight      smallint not null default 1 check (weight between 1 and 10),
  active      boolean not null default true,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create or replace view public.coin_balances with (security_invoker = true) as
  select couple_id, user_id, coalesce(sum(delta), 0)::integer as balance
  from public.coin_ledger
  group by couple_id, user_id;

-- Award coins when the OTHER partner approves a finished task.
create or replace function public.award_task_coins()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    if new.claimed_by is null then
      raise exception 'task must be claimed before approval';
    end if;
    if new.approved_by is null or new.approved_by = new.claimed_by then
      raise exception 'your partner has to approve your task';
    end if;
    if auth.uid() is not null and new.approved_by <> auth.uid() then
      raise exception 'you can only approve as yourself';
    end if;
    if new.reward_coins > 0 then
      insert into public.coin_ledger (couple_id, user_id, delta, reason, ref_table, ref_id)
      values (new.couple_id, new.claimed_by, new.reward_coins, 'Task: ' || new.title, 'tasks', new.id)
      on conflict do nothing;
    end if;
  end if;
  return new;
end $$;

-- Named tasks_zz_award so it fires after tasks_flow (Phase 2), which sets
-- approved_by; same-event triggers run in alphabetical order.
drop trigger if exists tasks_award on public.tasks;
drop trigger if exists tasks_zz_award on public.tasks;
create trigger tasks_zz_award
  before update of status on public.tasks
  for each row execute function public.award_task_coins();

-- Charge coins when a coupon is redeemed; refuse when the balance is short.
create or replace function public.charge_coupon()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_cost integer;
  v_balance integer;
begin
  select cost_coins into v_cost from public.coupons
  where id = new.coupon_id and couple_id = new.couple_id and active;
  if v_cost is null then raise exception 'coupon not available'; end if;

  -- Serialise redemptions per user so two taps cannot overspend.
  perform pg_advisory_xact_lock(hashtext(new.redeemed_by::text));
  select coalesce(sum(delta), 0) into v_balance
  from public.coin_ledger where user_id = new.redeemed_by and couple_id = new.couple_id;
  if v_balance < v_cost then raise exception 'not enough love coins (% of %)', v_balance, v_cost; end if;

  new.cost_coins := v_cost;
  insert into public.coin_ledger (couple_id, user_id, delta, reason, ref_table, ref_id)
  values (new.couple_id, new.redeemed_by, -v_cost, 'Coupon redeemed', 'coupon_redemptions', new.id);
  return new;
end $$;

drop trigger if exists coupon_redemptions_charge on public.coupon_redemptions;
create trigger coupon_redemptions_charge
  before insert on public.coupon_redemptions
  for each row execute function public.charge_coupon();

-- ---------------------------------------------------------------------
-- 6. Module 2 · Partner Vault
-- ---------------------------------------------------------------------
create table if not exists public.vault_entries (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  about_user  uuid not null references public.profiles (id) on delete cascade,
  category    text not null check (category in ('sizes', 'food', 'favorites', 'dietary', 'travel', 'other')),
  label       text not null check (char_length(label) between 1 and 60),
  value       text not null check (char_length(value) <= 500),
  sort        integer not null default 0,
  updated_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.important_dates (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 80),
  kind          text not null default 'other' check (kind in ('birthday', 'anniversary', 'trip', 'other')),
  starts_on     date not null,
  ends_on       date,
  recurs_yearly boolean not null default false,
  about_user    uuid references public.profiles (id) on delete set null,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 7. Module 3 · Finance
-- ---------------------------------------------------------------------
create table if not exists public.budget_settings (
  couple_id              uuid primary key default public.my_couple_id() references public.couples (id) on delete cascade,
  monthly_income_cents   bigint not null default 0 check (monthly_income_cents >= 0),
  needs_pct              smallint not null default 50,
  wants_pct              smallint not null default 30,
  savings_pct            smallint not null default 20,
  currency               text not null default 'USD',
  updated_at             timestamptz not null default now(),
  constraint budget_pct_sum check (needs_pct + wants_pct + savings_pct = 100)
);

create table if not exists public.bills (
  id             uuid primary key default gen_random_uuid(),
  couple_id      uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 80),
  amount_cents   bigint not null check (amount_cents >= 0),
  category       text,
  bucket         public.budget_bucket not null default 'needs',
  recurrence     text not null default 'monthly' check (recurrence in ('none', 'weekly', 'monthly', 'yearly')),
  due_day        smallint check (due_day between 1 and 31),   -- monthly bills
  next_due_on    date not null,
  autopay        boolean not null default false,
  responsible    uuid references public.profiles (id) on delete set null,
  active         boolean not null default true,
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists bills_due_idx on public.bills (couple_id, next_due_on) where active;

create table if not exists public.bill_payments (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  bill_id       uuid not null references public.bills (id) on delete cascade,
  period_due_on date not null,
  amount_cents  bigint not null check (amount_cents >= 0),
  paid_by       uuid default auth.uid() references auth.users (id) on delete set null,
  paid_at       timestamptz not null default now(),
  unique (bill_id, period_due_on)
);

create table if not exists public.sinking_funds (
  id             uuid primary key default gen_random_uuid(),
  couple_id      uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 60),
  emoji          text not null default '💰',
  target_cents   bigint not null check (target_cents > 0),
  saved_cents    bigint not null default 0 check (saved_cents >= 0),
  target_date    date,
  sort           integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.receipts (
  id             uuid primary key default gen_random_uuid(),
  couple_id      uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  uploaded_by    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  storage_path   text not null,                           -- bucket "receipts"
  status         text not null default 'pending' check (status in ('pending', 'processing', 'done', 'error')),
  merchant       text,
  purchased_on   date,
  category       text,
  total_cents    bigint check (total_cents >= 0),
  line_items     jsonb not null default '[]'::jsonb,
  ai_raw         jsonb,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.expenses (
  id             uuid primary key default gen_random_uuid(),
  couple_id      uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  receipt_id     uuid references public.receipts (id) on delete set null,
  title          text not null check (char_length(title) between 1 and 120),
  amount_cents   bigint not null check (amount_cents > 0),
  spent_on       date not null default current_date,
  category       text,
  bucket         public.budget_bucket not null default 'wants',
  paid_by        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  split          public.expense_split not null default 'joint',
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists expenses_spent_idx on public.expenses (couple_id, spent_on desc);

create table if not exists public.settlements (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  from_user     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  to_user       uuid not null references auth.users (id) on delete cascade,
  amount_cents  bigint not null check (amount_cents > 0),
  note          text check (char_length(note) <= 140),
  settled_on    date not null default current_date,
  created_at    timestamptz not null default now(),
  check (from_user <> to_user)
);

-- One line per thing that moves the "who owes whom" balance.
-- creditor_id is owed amount_cents by the other partner.
-- Net for me = sum(lines where creditor = me) - sum(lines where creditor = partner).
create or replace view public.ledger_lines with (security_invoker = true) as
  select e.couple_id,
         'expense'::text as source,
         e.id as source_id,
         e.paid_by as creditor_id,
         case e.split
           when 'split_even' then round(e.amount_cents / 2.0)::bigint
           when 'full_owed'  then e.amount_cents
         end as amount_cents,
         e.spent_on as on_date
  from public.expenses e
  where e.split <> 'joint'
  union all
  select s.couple_id, 'settlement', s.id, s.from_user, s.amount_cents, s.settled_on
  from public.settlements s;

-- ---------------------------------------------------------------------
-- 8. Module 4 · Wishlists (with Surprise Lock)
-- ---------------------------------------------------------------------
create table if not exists public.wishlist_boards (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  kind        public.wishlist_kind not null,
  owner_id    uuid references public.profiles (id) on delete cascade,  -- personal board; NULL = shared
  title       text check (char_length(title) <= 60),                   -- NULL = derive from owner's display name
  emoji       text not null default '🎁',
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.wishlist_items (
  id               uuid primary key default gen_random_uuid(),
  couple_id        uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  board_id         uuid not null references public.wishlist_boards (id) on delete cascade,
  url              text,
  title            text not null check (char_length(title) between 1 and 300),
  image_url        text,
  price_cents      bigint check (price_cents >= 0),
  currency         text default 'USD',
  store            text,
  asin             text check (asin ~ '^[A-Z0-9]{10}$'),
  priority         public.wishlist_priority not null default 'treat',
  notes            text check (char_length(notes) <= 1000),
  owner_purchased  boolean not null default false,   -- the owner bought it themselves (visible to both)
  metadata         jsonb not null default '{}'::jsonb,
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists wishlist_items_board_idx on public.wishlist_items (board_id);

do $$ begin
  alter table public.meal_options
    add constraint meal_options_wishlist_item_fk
    foreign key (wishlist_item_id) references public.wishlist_items (id) on delete set null;
exception when duplicate_object then null; end $$;

-- Surprise Lock: a claim row is visible ONLY to the person who made it.
-- The board owner's queries never see it, so the item looks untouched.
-- The primary key is a random id, not item_id: Realtime DELETE events carry
-- only the primary key and are not RLS-filtered, so keying on item_id would
-- leak "something happened to item X" to the person being surprised.
create table if not exists public.wishlist_claims (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null unique references public.wishlist_items (id) on delete cascade,
  couple_id   uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  claimed_by  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  note        text check (char_length(note) <= 280),
  created_at  timestamptz not null default now()
);

create or replace function public.can_claim_item(p_item_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.wishlist_items i
    join public.wishlist_boards b on b.id = i.board_id
    where i.id = p_item_id
      and i.couple_id = (select couple_id from public.profiles where id = auth.uid())
      and b.owner_id is distinct from auth.uid()        -- you cannot surprise yourself
  )
$$;

-- ---------------------------------------------------------------------
-- 9. Module 5 · Events & calendar
-- ---------------------------------------------------------------------
create table if not exists public.saved_events (
  id           uuid primary key default gen_random_uuid(),
  couple_id    uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  source       text not null default 'ticketmaster',
  external_id  text not null,
  name         text not null,
  starts_at    timestamptz,
  venue        text,
  address      text,
  lat          double precision,
  lng          double precision,
  url          text,
  image_url    text,
  price_min    numeric(10, 2),
  price_max    numeric(10, 2),
  raw          jsonb,
  saved_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (couple_id, source, external_id)
);

create table if not exists public.calendar_events (
  id           uuid primary key default gen_random_uuid(),
  couple_id    uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 120),
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  all_day      boolean not null default false,
  location     text,
  source_type  text check (source_type in ('saved_event', 'dinner_match', 'bill', 'manual', 'date_idea')),
  source_id    uuid,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);
create index if not exists calendar_events_starts_idx on public.calendar_events (couple_id, starts_at);

-- ---------------------------------------------------------------------
-- 10. Module 6 · TikTok vault & notes importer
-- ---------------------------------------------------------------------
create table if not exists public.tiktok_videos (
  id             uuid primary key default gen_random_uuid(),
  couple_id      uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  sent_by        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  share_url      text not null,
  video_id       text not null check (video_id ~ '^[0-9]{15,21}$'),
  title          text,
  author_name    text,
  thumbnail_url  text,
  tags           text[] not null default '{}',
  note           text check (char_length(note) <= 500),
  ai_suggestion  jsonb,                 -- {kind, label, board_kind, confidence}
  created_at     timestamptz not null default now(),
  unique (couple_id, video_id)
);

create table if not exists public.tiktok_views (
  video_id    uuid not null references public.tiktok_videos (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  couple_id   uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  watched_at  timestamptz not null default now(),
  primary key (video_id, user_id)
);

create table if not exists public.tiktok_reactions (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  video_id    uuid not null references public.tiktok_videos (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  emoji       text not null check (char_length(emoji) <= 8),
  created_at  timestamptz not null default now(),
  unique (video_id, user_id, emoji)
);

create table if not exists public.tiktok_comments (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  video_id    uuid not null references public.tiktok_videos (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);

create table if not exists public.notes_inbox (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  created_by    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source        text not null default 'paste' check (source in ('paste', 'share_sheet', 'apple_notes')),
  raw_text      text check (char_length(raw_text) <= 20000),
  raw_url       text,
  detected_kind text check (detected_kind in ('tiktok', 'amazon', 'url', 'note')),
  status        text not null default 'pending' check (status in ('pending', 'processing', 'routed', 'error')),
  parsed        jsonb,
  routed_to     jsonb,                  -- {table, id}
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.checklists (
  id              uuid primary key default gen_random_uuid(),
  couple_id       uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 80),
  kind            text not null default 'todo' check (kind in ('grocery', 'todo', 'budget', 'other')),
  source_note_id  uuid references public.notes_inbox (id) on delete set null,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  archived        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.checklist_items (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null default public.my_couple_id() references public.couples (id) on delete cascade,
  checklist_id  uuid not null references public.checklists (id) on delete cascade,
  body          text not null check (char_length(body) between 1 and 300),
  quantity      text,
  is_done       boolean not null default false,
  done_by       uuid references auth.users (id) on delete set null,
  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists checklist_items_list_idx on public.checklist_items (checklist_id, position);

-- =====================================================================
-- 11. Row Level Security
-- =====================================================================

-- 11a. Couples
alter table public.couples enable row level security;
drop policy if exists couples_select on public.couples;
create policy couples_select on public.couples for select to authenticated
  using (id = (select public.my_couple_id()));
drop policy if exists couples_update on public.couples;
create policy couples_update on public.couples for update to authenticated
  using (id = (select public.my_couple_id()))
  with check (id = (select public.my_couple_id()));
-- Rows are only created via create_couple(); members can only edit cosmetic fields.
revoke insert, update, delete on public.couples from anon, authenticated;
grant select on public.couples to authenticated;
grant update (name, timezone, home_city, home_state) on public.couples to authenticated;

-- 11b. Profiles
alter table public.profiles enable row level security;
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or couple_id = (select public.my_couple_id()));
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
-- couple_id and slot can only change through create_couple()/join_couple().
revoke insert, update, delete on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_emoji, accent, mood_emoji, status_kind, status_text,
              social_battery, status_updated_at, last_seen_at)
  on public.profiles to authenticated;

-- 11c. Owner-only device/security tables
do $$
declare t text;
begin
  foreach t in array array['push_subscriptions', 'webauthn_credentials'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))', t || '_owner', t);
  end loop;
end $$;

alter table public.inbox_tokens enable row level security;
drop policy if exists inbox_tokens_owner_select on public.inbox_tokens;
create policy inbox_tokens_owner_select on public.inbox_tokens for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists inbox_tokens_owner_update on public.inbox_tokens;
create policy inbox_tokens_owner_update on public.inbox_tokens for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke insert, delete on public.inbox_tokens from anon, authenticated;   -- insert only via create_inbox_token()
revoke update on public.inbox_tokens from anon, authenticated;
grant update (label, revoked_at) on public.inbox_tokens to authenticated;

-- 11d. Standard couple-scoped tables: both partners have full access to rows
--      in their own space, and nothing else.
do $$
declare t text;
begin
  foreach t in array array[
    'wallpaper_settings', 'love_pings', 'question_assignments', 'voice_notes', 'memories',
    'tasks', 'coupons', 'date_ideas', 'vault_entries', 'important_dates',
    'budget_settings', 'bills', 'bill_payments', 'sinking_funds', 'receipts', 'expenses',
    'settlements', 'wishlist_boards', 'wishlist_items', 'saved_events', 'calendar_events',
    'tiktok_videos', 'notes_inbox', 'checklists', 'checklist_items'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_couple', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (couple_id = (select public.my_couple_id()))
         with check (couple_id = (select public.my_couple_id()))', t || '_couple', t);
    execute format('create index if not exists %I on public.%I (couple_id)', t || '_couple_idx', t);
  end loop;
end $$;

-- 11e. Couple-readable, author-writable tables (you can only write as yourself)
do $$
declare
  t text;
  col text;
begin
  for t, col in
    select * from (values
      ('question_comments', 'user_id'),
      ('dinner_swipes',     'user_id'),
      ('tiktok_views',      'user_id'),
      ('tiktok_reactions',  'user_id'),
      ('tiktok_comments',   'user_id')
    ) v(t, col)
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (couple_id = (select public.my_couple_id()))', t || '_read', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (%I = (select auth.uid()) and couple_id = (select public.my_couple_id()))
         with check (%I = (select auth.uid()) and couple_id = (select public.my_couple_id()))',
      t || '_write', t, col, col);
    execute format('create index if not exists %I on public.%I (couple_id)', t || '_couple_idx', t);
  end loop;
end $$;

-- 11f. Blind daily answers: your own answer is always visible to you;
--      your partner's becomes visible only once you have both answered.
alter table public.question_answers enable row level security;
drop policy if exists question_answers_select on public.question_answers;
create policy question_answers_select on public.question_answers for select to authenticated
  using (
    couple_id = (select public.my_couple_id())
    and (user_id = (select auth.uid()) or public.question_unlocked(assignment_id))
  );
drop policy if exists question_answers_insert on public.question_answers;
create policy question_answers_insert on public.question_answers for insert to authenticated
  with check (user_id = (select auth.uid()) and couple_id = (select public.my_couple_id()));
drop policy if exists question_answers_update on public.question_answers;
create policy question_answers_update on public.question_answers for update to authenticated
  using (user_id = (select auth.uid()) and not public.question_unlocked(assignment_id))
  with check (user_id = (select auth.uid()));
create index if not exists question_answers_assignment_idx on public.question_answers (assignment_id);

-- 11g. Global question deck: readable by any signed-in user, writable by nobody.
alter table public.daily_questions enable row level security;
drop policy if exists daily_questions_read on public.daily_questions;
create policy daily_questions_read on public.daily_questions for select to authenticated using (active);

-- 11h. Meal options: global seed cards (couple_id NULL) are read-only; your own are full access.
alter table public.meal_options enable row level security;
drop policy if exists meal_options_read on public.meal_options;
create policy meal_options_read on public.meal_options for select to authenticated
  using (couple_id is null or couple_id = (select public.my_couple_id()));
drop policy if exists meal_options_write on public.meal_options;
create policy meal_options_write on public.meal_options for all to authenticated
  using (couple_id = (select public.my_couple_id()))
  with check (couple_id = (select public.my_couple_id()));
alter table public.meal_options alter column couple_id set default public.my_couple_id();

-- 11i. Dinner matches & coin ledger: read-only to clients, written by triggers.
do $$
declare t text;
begin
  foreach t in array array['dinner_matches', 'coin_ledger'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (couple_id = (select public.my_couple_id()))', t || '_read', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('create index if not exists %I on public.%I (couple_id)', t || '_couple_idx', t);
  end loop;
end $$;

-- 11j. Coupon redemptions: anyone in the couple reads; you redeem as yourself;
--      either partner can mark fulfilled.
alter table public.coupon_redemptions enable row level security;
drop policy if exists coupon_redemptions_read on public.coupon_redemptions;
create policy coupon_redemptions_read on public.coupon_redemptions for select to authenticated
  using (couple_id = (select public.my_couple_id()));
drop policy if exists coupon_redemptions_insert on public.coupon_redemptions;
create policy coupon_redemptions_insert on public.coupon_redemptions for insert to authenticated
  with check (redeemed_by = (select auth.uid()) and couple_id = (select public.my_couple_id()));
drop policy if exists coupon_redemptions_update on public.coupon_redemptions;
create policy coupon_redemptions_update on public.coupon_redemptions for update to authenticated
  using (couple_id = (select public.my_couple_id()))
  with check (couple_id = (select public.my_couple_id()));
revoke update on public.coupon_redemptions from authenticated;
grant update (status, fulfilled_at) on public.coupon_redemptions to authenticated;
create index if not exists coupon_redemptions_couple_idx on public.coupon_redemptions (couple_id);

-- 11k. Surprise Lock claims: visible to and editable by the claimer only.
alter table public.wishlist_claims enable row level security;
drop policy if exists wishlist_claims_claimer on public.wishlist_claims;
create policy wishlist_claims_claimer on public.wishlist_claims for all to authenticated
  using (claimed_by = (select auth.uid()))
  with check (claimed_by = (select auth.uid()) and public.can_claim_item(item_id));

-- 11l. Function privileges: nothing callable by anonymous visitors.
revoke all on function public.my_couple_id() from public, anon;
revoke all on function public.my_partner_id() from public, anon;
revoke all on function public.create_couple(text, text) from public, anon;
revoke all on function public.join_couple(text, text) from public, anon;
revoke all on function public.create_inbox_token(text) from public, anon;
revoke all on function public.question_unlocked(uuid) from public, anon;
revoke all on function public.can_claim_item(uuid) from public, anon;
grant execute on function public.my_couple_id() to authenticated;
grant execute on function public.my_partner_id() to authenticated;
grant execute on function public.create_couple(text, text) to authenticated;
grant execute on function public.join_couple(text, text) to authenticated;
grant execute on function public.create_inbox_token(text) to authenticated;
grant execute on function public.question_unlocked(uuid) to authenticated;
grant execute on function public.can_claim_item(uuid) to authenticated;
-- Trigger-only functions must not be exposed as RPC endpoints.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.detect_dinner_match() from public, anon, authenticated;
revoke all on function public.award_task_coins() from public, anon, authenticated;
revoke all on function public.charge_coupon() from public, anon, authenticated;

-- =====================================================================
-- 12. updated_at triggers
-- =====================================================================
do $$
declare t text;
begin
  for t in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'updated_at'
      and c.table_name not like 'mkcinema%'  -- shared project: leave the other app's tables alone
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function public.touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- =====================================================================
-- 13. Realtime publication
--     postgres_changes respects RLS, so the blind-answer and Surprise Lock
--     rules apply to live events too.
-- =====================================================================
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array[
    'profiles', 'couples', 'wallpaper_settings', 'love_pings',
    'question_assignments', 'question_answers', 'question_comments',
    'voice_notes', 'memories', 'dinner_swipes', 'dinner_matches',
    'tasks', 'coin_ledger', 'coupons', 'coupon_redemptions',
    'vault_entries', 'important_dates',
    'bills', 'bill_payments', 'sinking_funds', 'receipts', 'expenses', 'settlements',
    'wishlist_boards', 'wishlist_items', 'wishlist_claims',
    'saved_events', 'calendar_events',
    'tiktok_videos', 'tiktok_views', 'tiktok_reactions', 'tiktok_comments',
    'notes_inbox', 'checklists', 'checklist_items'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- =====================================================================
-- 14. Storage buckets (all PRIVATE; files are read via signed URLs)
--     Path convention for every bucket:  {couple_id}/{user_id}/{filename}
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('wallpapers',  'wallpapers',  false, 10485760,
     array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
  ('receipts',    'receipts',    false, 10485760,
     array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']),
  ('voice-notes', 'voice-notes', false, 2097152,
     array['audio/webm', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/ogg', 'audio/x-m4a']),
  ('memories',    'memories',    false, 10485760,
     array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists couple_files_read on storage.objects;
create policy couple_files_read on storage.objects for select to authenticated
  using (
    bucket_id in ('wallpapers', 'receipts', 'voice-notes', 'memories')
    and (storage.foldername(name))[1] = (select public.my_couple_id())::text
  );

drop policy if exists couple_files_insert on storage.objects;
create policy couple_files_insert on storage.objects for insert to authenticated
  with check (
    bucket_id in ('wallpapers', 'receipts', 'voice-notes', 'memories')
    and (storage.foldername(name))[1] = (select public.my_couple_id())::text
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists couple_files_update on storage.objects;
create policy couple_files_update on storage.objects for update to authenticated
  using (
    bucket_id in ('wallpapers', 'receipts', 'voice-notes', 'memories')
    and owner_id = (select auth.uid())::text
  )
  with check (
    (storage.foldername(name))[1] = (select public.my_couple_id())::text
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists couple_files_delete on storage.objects;
create policy couple_files_delete on storage.objects for delete to authenticated
  using (
    bucket_id in ('wallpapers', 'receipts', 'voice-notes', 'memories')
    and (storage.foldername(name))[1] = (select public.my_couple_id())::text
    and owner_id = (select auth.uid())::text
  );

-- End of schema.
