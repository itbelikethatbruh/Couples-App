-- =====================================================================
--  Couples App · Phase 3 migration (Money + Smart Wishlists)
--  Copyright (c) 2026. All Rights Reserved. See LICENSE.
--
--  Run AFTER schema.sql and phase2.sql: SQL Editor → paste → Run.
--  Safe to re-run. All tables already exist (schema.sql); this adds the
--  server-side rules and functions the Money and Wishlist tabs use.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Membership helper
-- ---------------------------------------------------------------------
-- True when p_user is one of the two seats in the caller's couple.
create or replace function public.is_couple_member(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user is not null and exists (
    select 1 from public.profiles
    where id = p_user
      and couple_id = (select couple_id from public.profiles where id = auth.uid())
  )
$$;

-- ---------------------------------------------------------------------
-- 2. Row guards: people referenced on a row must belong to this couple,
--    and "who created it" is always the signed-in user.
-- ---------------------------------------------------------------------
create or replace function public.guard_money_rows()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;    -- service role / SQL editor

  if tg_table_name = 'expenses' then
    if tg_op = 'INSERT' then new.created_by := auth.uid(); else new.created_by := old.created_by; end if;
    if not public.is_couple_member(new.paid_by) then
      raise exception 'paid_by must be you or your partner';
    end if;
  elsif tg_table_name = 'settlements' then
    if not public.is_couple_member(new.from_user) or not public.is_couple_member(new.to_user) then
      raise exception 'a settlement must be between the two of you';
    end if;
  elsif tg_table_name = 'bills' then
    if tg_op = 'INSERT' then new.created_by := auth.uid(); else new.created_by := old.created_by; end if;
    if new.responsible is not null and not public.is_couple_member(new.responsible) then
      raise exception 'responsible must be you or your partner';
    end if;
  elsif tg_table_name = 'receipts' then
    if tg_op = 'INSERT' then
      new.uploaded_by := auth.uid();
    else
      new.uploaded_by := old.uploaded_by;
      new.storage_path := old.storage_path;      -- the photo of a receipt never changes
    end if;
    if split_part(new.storage_path, '/', 1) <> new.couple_id::text then
      raise exception 'receipt file must live in your couple folder';
    end if;
  elsif tg_table_name = 'wishlist_boards' then
    if new.owner_id is not null and not public.is_couple_member(new.owner_id) then
      raise exception 'board owner must be you or your partner';
    end if;
  elsif tg_table_name = 'wishlist_items' then
    if tg_op = 'INSERT' then new.created_by := auth.uid(); else new.created_by := old.created_by; end if;
    if not exists (select 1 from public.wishlist_boards b where b.id = new.board_id and b.couple_id = new.couple_id) then
      raise exception 'board not found';
    end if;
  elsif tg_table_name = 'bill_payments' then
    if tg_op = 'INSERT' then new.paid_by := auth.uid(); end if;
    if not exists (select 1 from public.bills b where b.id = new.bill_id and b.couple_id = new.couple_id) then
      raise exception 'bill not found';
    end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['expenses', 'settlements', 'bills', 'receipts', 'wishlist_boards', 'wishlist_items', 'bill_payments'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_guard', t);
    execute format(
      'create trigger %I before insert or update on public.%I
         for each row execute function public.guard_money_rows()', t || '_guard', t);
  end loop;
end $$;

-- Surprise Lock: a claim's couple is always the item's couple, and the
-- claimer is always the signed-in user.
create or replace function public.guard_wishlist_claim()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  new.claimed_by := auth.uid();
  select i.couple_id into new.couple_id from public.wishlist_items i where i.id = new.item_id;
  return new;
end $$;

drop trigger if exists wishlist_claims_guard on public.wishlist_claims;
create trigger wishlist_claims_guard
  before insert or update on public.wishlist_claims
  for each row execute function public.guard_wishlist_claim();

-- ---------------------------------------------------------------------
-- 3. Bills: pay (rolls the due date forward) and undo
-- ---------------------------------------------------------------------
-- Next due date after p_from, keeping the bill's day of month and clamping
-- to short months (a bill due on the 31st is due Feb 28/29).
create or replace function public.next_bill_date(p_from date, p_recurrence text, p_due_day smallint)
returns date language plpgsql immutable set search_path = '' as $$
declare
  v_month date;
  v_day int;
  v_last int;
begin
  if p_recurrence = 'weekly' then return p_from + 7; end if;
  if p_recurrence = 'yearly' then return (p_from + interval '1 year')::date; end if;
  if p_recurrence = 'monthly' then
    v_month := (date_trunc('month', p_from) + interval '1 month')::date;
    v_day := coalesce(p_due_day, extract(day from p_from)::int);
    v_last := extract(day from (v_month + interval '1 month - 1 day'))::int;
    return v_month + (least(v_day, v_last) - 1);
  end if;
  return null;                                     -- 'none': one-off bill
end $$;

-- Records a payment for the current period and advances the bill.
-- SECURITY INVOKER: Row Level Security still applies to every statement.
create or replace function public.pay_bill(p_bill_id uuid, p_amount_cents bigint default null)
returns public.bills language plpgsql security invoker set search_path = '' as $$
declare
  v_bill public.bills;
begin
  select * into v_bill from public.bills where id = p_bill_id for update;
  if v_bill.id is null then raise exception 'bill not found'; end if;
  if not v_bill.active then raise exception 'this bill is already settled'; end if;

  insert into public.bill_payments (couple_id, bill_id, period_due_on, amount_cents)
  values (v_bill.couple_id, v_bill.id, v_bill.next_due_on, coalesce(p_amount_cents, v_bill.amount_cents));

  if v_bill.recurrence = 'none' then
    update public.bills set active = false where id = v_bill.id returning * into v_bill;
  else
    update public.bills
       set next_due_on = public.next_bill_date(v_bill.next_due_on, v_bill.recurrence, v_bill.due_day)
     where id = v_bill.id
    returning * into v_bill;
  end if;
  return v_bill;
end $$;

-- Undo only the most recent payment of a bill: deletes it and puts the
-- due date back to the period it paid.
create or replace function public.undo_bill_payment(p_payment_id uuid)
returns public.bills language plpgsql security invoker set search_path = '' as $$
declare
  v_pay public.bill_payments;
  v_bill public.bills;
begin
  select * into v_pay from public.bill_payments where id = p_payment_id;
  if v_pay.id is null then raise exception 'payment not found'; end if;
  select * into v_bill from public.bills where id = v_pay.bill_id for update;
  if exists (select 1 from public.bill_payments
             where bill_id = v_pay.bill_id and period_due_on > v_pay.period_due_on) then
    raise exception 'only the latest payment can be undone';
  end if;
  delete from public.bill_payments where id = v_pay.id;
  update public.bills set next_due_on = v_pay.period_due_on, active = true
   where id = v_pay.bill_id
  returning * into v_bill;
  return v_bill;
end $$;

-- ---------------------------------------------------------------------
-- 4. Sinking funds: atomic add/withdraw (two phones tapping at once
--    must not lose a deposit)
-- ---------------------------------------------------------------------
create or replace function public.fund_adjust(p_fund_id uuid, p_delta_cents bigint)
returns public.sinking_funds language plpgsql security invoker set search_path = '' as $$
declare
  v_fund public.sinking_funds;
begin
  if p_delta_cents is null or p_delta_cents = 0 then raise exception 'amount must not be zero'; end if;
  update public.sinking_funds
     set saved_cents = greatest(0, saved_cents + p_delta_cents)
   where id = p_fund_id
  returning * into v_fund;
  if v_fund.id is null then raise exception 'fund not found'; end if;
  return v_fund;
end $$;

-- ---------------------------------------------------------------------
-- 5. Budget: what was spent in a month, per 50/30/20 bucket
--    (logged expenses + bills marked paid in that month)
-- ---------------------------------------------------------------------
create or replace function public.budget_month(p_month date default current_date)
returns table (bucket public.budget_bucket, spent_cents bigint)
language sql stable security invoker set search_path = '' as $$
  with bounds as (
    select date_trunc('month', p_month)::date as m0,
           (date_trunc('month', p_month) + interval '1 month')::date as m1
  ),
  spend as (
    select e.bucket, e.amount_cents
    from public.expenses e, bounds
    where e.spent_on >= bounds.m0 and e.spent_on < bounds.m1
    union all
    select b.bucket, p.amount_cents
    from public.bill_payments p
    join public.bills b on b.id = p.bill_id, bounds
    where p.paid_at >= bounds.m0 and p.paid_at < bounds.m1
  )
  select k.bucket, coalesce(sum(s.amount_cents), 0)::bigint
  from unnest(enum_range(null::public.budget_bucket)) as k(bucket)
  left join spend s on s.bucket = k.bucket
  group by k.bucket
  order by k.bucket
$$;

-- ---------------------------------------------------------------------
-- 6. Settle-up: net balance from the caller's point of view.
--    Positive = your partner owes you; negative = you owe your partner.
-- ---------------------------------------------------------------------
create or replace function public.settle_balance()
returns bigint language sql stable security invoker set search_path = '' as $$
  select coalesce(sum(case when creditor_id = auth.uid() then amount_cents else -amount_cents end), 0)::bigint
  from public.ledger_lines
  where couple_id = (select couple_id from public.profiles where id = auth.uid())
$$;

-- ---------------------------------------------------------------------
-- 7. Wishlist boards: one personal Amazon board per partner, plus shared
--    Restaurants / Vacations / Events boards. Called by the app on open;
--    adds the second partner's board the first time it runs after they join.
-- ---------------------------------------------------------------------
create or replace function public.ensure_wishlist_boards()
returns setof public.wishlist_boards language plpgsql security definer set search_path = '' as $$
declare
  v_couple uuid := (select couple_id from public.profiles where id = auth.uid());
  v_p record;
begin
  if v_couple is null then raise exception 'pair with your partner first'; end if;
  perform pg_advisory_xact_lock(hashtext('wishlist_boards:' || v_couple::text));

  for v_p in select id from public.profiles where couple_id = v_couple order by slot loop
    if not exists (select 1 from public.wishlist_boards
                   where couple_id = v_couple and owner_id = v_p.id and kind = 'amazon') then
      insert into public.wishlist_boards (couple_id, kind, owner_id, emoji, sort)
      values (v_couple, 'amazon', v_p.id, '🎁', 0);
    end if;
  end loop;

  insert into public.wishlist_boards (couple_id, kind, owner_id, title, emoji, sort)
  select v_couple, d.kind::public.wishlist_kind, null, d.title, d.emoji, d.sort
  from (values ('restaurants', 'Restaurants', '🍽️', 10),
               ('vacations',   'Vacations',   '✈️', 20),
               ('events',      'Events',      '🎟️', 30)) as d(kind, title, emoji, sort)
  where not exists (select 1 from public.wishlist_boards b
                    where b.couple_id = v_couple and b.kind = d.kind::public.wishlist_kind and b.owner_id is null);

  return query select * from public.wishlist_boards where couple_id = v_couple order by sort, created_at;
end $$;

-- ---------------------------------------------------------------------
-- 8. Privileges
-- ---------------------------------------------------------------------
revoke all on function public.is_couple_member(uuid) from public, anon;
revoke all on function public.next_bill_date(date, text, smallint) from public, anon;
revoke all on function public.pay_bill(uuid, bigint) from public, anon;
revoke all on function public.undo_bill_payment(uuid) from public, anon;
revoke all on function public.fund_adjust(uuid, bigint) from public, anon;
revoke all on function public.budget_month(date) from public, anon;
revoke all on function public.settle_balance() from public, anon;
revoke all on function public.ensure_wishlist_boards() from public, anon;
grant execute on function public.is_couple_member(uuid) to authenticated;
grant execute on function public.next_bill_date(date, text, smallint) to authenticated;
grant execute on function public.pay_bill(uuid, bigint) to authenticated;
grant execute on function public.undo_bill_payment(uuid) to authenticated;
grant execute on function public.fund_adjust(uuid, bigint) to authenticated;
grant execute on function public.budget_month(date) to authenticated;
grant execute on function public.settle_balance() to authenticated;
grant execute on function public.ensure_wishlist_boards() to authenticated;
revoke all on function public.guard_money_rows() from public, anon, authenticated;
revoke all on function public.guard_wishlist_claim() from public, anon, authenticated;

-- Bill payments are written by pay_bill() (invoker) and removed by
-- undo_bill_payment(); clients never edit an existing payment row.
revoke update on public.bill_payments from authenticated;

-- Helpful indexes for the Money tab's monthly queries.
create index if not exists bill_payments_paid_idx on public.bill_payments (couple_id, paid_at desc);
create index if not exists settlements_couple_date_idx on public.settlements (couple_id, settled_on desc);
create index if not exists receipts_couple_created_idx on public.receipts (couple_id, created_at desc);

-- Budget settings changes should sync live to the other phone too.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'budget_settings') then
    alter publication supabase_realtime add table public.budget_settings;
  end if;
end $$;

-- End of Phase 3 migration.
