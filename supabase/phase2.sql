-- =====================================================================
--  Couples App · Phase 2 migration (Spark Hub + Partner Vault)
--  Copyright (c) 2026. All Rights Reserved. See LICENSE.
--
--  Run AFTER schema.sql: SQL Editor → paste → Run. Safe to re-run.
--  Adds: question deck, dinner card seeds, default coupons and date
--  ideas, and the server functions the Spark Hub uses.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Daily question deck (global, read-only to clients)
-- ---------------------------------------------------------------------
insert into public.daily_questions (category, prompt) values
  -- Fun
  ('fun', 'If we swapped lives for a day, what is the first thing you would do as me?'),
  ('fun', 'What is the most ridiculous thing we have ever argued about?'),
  ('fun', 'Which movie couple are we most like, honestly?'),
  ('fun', 'If we opened a restaurant together, what would it serve and what would we name it?'),
  ('fun', 'What song should play every time I walk into a room?'),
  ('fun', 'What is my most annoying habit that you secretly find cute?'),
  ('fun', 'If we had a reality show, what would the title be?'),
  ('fun', 'Which snack would you fight me for?'),
  ('fun', 'What would our couple superpower be?'),
  ('fun', 'Describe our last date using only three emojis.'),
  ('fun', 'If you could add one rule to our home, what would it be?'),
  ('fun', 'What is the funniest thing I have said while half asleep?'),
  ('fun', 'Which of my outfits deserves a retirement party?'),
  ('fun', 'If we were a duo in a heist movie, what are our roles?'),
  ('fun', 'What is one thing you would bet I could never do?'),
  ('fun', 'What is your favorite inside joke of ours, and where did it start?'),
  ('fun', 'What would you name our future pet, and what kind is it?'),
  ('fun', 'Pick a theme for our next at-home date night.'),
  ('fun', 'What is a talent you wish I knew you had?'),
  ('fun', 'Which celebrity would you trust to plan our anniversary?'),
  -- Deep
  ('deep', 'When did you feel most loved by me this month?'),
  ('deep', 'What is something you have never told me because you were afraid of how I would react?'),
  ('deep', 'What part of your childhood shows up in how you love me?'),
  ('deep', 'What do you need more of from me when you are stressed?'),
  ('deep', 'What is one thing I do that makes you feel safe?'),
  ('deep', 'What fear about us do you carry that I could help with?'),
  ('deep', 'What is a moment you were proud of me that I might not know about?'),
  ('deep', 'How do you know when I am upset before I say anything?'),
  ('deep', 'What does a perfect apology look like to you?'),
  ('deep', 'What is something you are still healing from?'),
  ('deep', 'Which of our hard seasons made us stronger, and how?'),
  ('deep', 'What do you wish I asked you about more often?'),
  ('deep', 'What is one way I have changed you for the better?'),
  ('deep', 'When do you feel most like yourself with me?'),
  ('deep', 'What is a belief you hold that has changed since we met?'),
  ('deep', 'How can I support your dreams better this year?'),
  ('deep', 'What is something small I do that means a lot to you?'),
  ('deep', 'What does home feel like to you?'),
  ('deep', 'What are you most grateful for about us right now?'),
  ('deep', 'What would you want me to remember if we ever forget why we started?'),
  -- Spicy
  ('spicy', 'What is something I do that instantly gets your attention?'),
  ('spicy', 'Describe your ideal date night that ends at home.'),
  ('spicy', 'What outfit of mine do you think about later?'),
  ('spicy', 'What is a fantasy date location you would love to try?'),
  ('spicy', 'When did you last catch yourself staring at me?'),
  ('spicy', 'What is one compliment you want to hear more often?'),
  ('spicy', 'What kind of kiss is your favorite?'),
  ('spicy', 'What is the most romantic thing I have ever done for you?'),
  ('spicy', 'What is one new thing you want us to try together?'),
  ('spicy', 'What song puts you in the mood?'),
  ('spicy', 'Where is the most unexpected place you have wanted to kiss me?'),
  ('spicy', 'What is your favorite way for me to start a morning with you?'),
  ('spicy', 'What text from me would make your whole day?'),
  ('spicy', 'What is a scent that reminds you of me?'),
  ('spicy', 'Plan a surprise for me tonight in one sentence.'),
  ('spicy', 'What is one thing that makes you feel desired?'),
  ('spicy', 'What is your favorite memory of us being completely alone?'),
  ('spicy', 'Rate our last date night out of 10 and say what would make it an 11.'),
  ('spicy', 'What is a flirty nickname you want to try out?'),
  ('spicy', 'What do you love most about how I look at you?'),
  -- Future
  ('future', 'Where do you see us living in five years?'),
  ('future', 'What is one trip we have to take before we turn 40?'),
  ('future', 'What tradition do you want us to start this year?'),
  ('future', 'What does financial freedom look like for us?'),
  ('future', 'What is a skill you want us to learn together?'),
  ('future', 'Describe a perfect ordinary Tuesday ten years from now.'),
  ('future', 'What is one goal you want me to hold you accountable to?'),
  ('future', 'How do you want to celebrate our next anniversary?'),
  ('future', 'What would our dream home have that our current one does not?'),
  ('future', 'What legacy do you want our family to leave?'),
  ('future', 'What is one habit we should build together this month?'),
  ('future', 'If money were no object, what would we do next year?'),
  ('future', 'What is something we should save for starting now?'),
  ('future', 'What do you want our weekends to look like when we are older?'),
  ('future', 'Which city should we explore together next?'),
  ('future', 'What is one fear about the future we should plan for together?'),
  ('future', 'What would you want our love story to sound like when we tell it at 80?'),
  ('future', 'What is a big decision coming up that we should start talking about?'),
  ('future', 'What is a small luxury we should make room for in our budget?'),
  ('future', 'What is a promise you want to make to me for this year?')
on conflict (prompt) do nothing;

-- ---------------------------------------------------------------------
-- 2. Global dinner cards
--    Pork dishes are included and flagged is_pork_free = false, so the
--    couple-level "Hide pork" switch (couples.hide_pork) can filter them.
-- ---------------------------------------------------------------------
alter table public.meal_options drop constraint if exists meal_seeds_pork_free;
alter table public.couples add column if not exists hide_pork boolean not null default false;
grant update (hide_pork) on public.couples to authenticated;

create unique index if not exists meal_options_global_title_uidx
  on public.meal_options (title) where couple_id is null;

insert into public.meal_options (couple_id, kind, title, cuisine, is_pork_free, created_by)
select null, v.kind, v.title, v.cuisine, v.pork_free, null
from (values
  ('home', 'Lemon garlic butter salmon', 'seafood', true),
  ('home', 'Chicken alfredo pasta', 'italian', true),
  ('home', 'Beef tacos with fresh pico', 'mexican', true),
  ('home', 'Shrimp fried rice', 'asian', true),
  ('home', 'Honey garlic chicken thighs', 'american', true),
  ('home', 'Smash burgers and fries', 'american', true),
  ('home', 'Chicken tikka masala', 'indian', true),
  ('home', 'Beef and broccoli stir fry', 'asian', true),
  ('home', 'Cajun shrimp and grits', 'southern', true),
  ('home', 'Margherita flatbread pizza', 'italian', true),
  ('home', 'Chicken fajita bowls', 'mexican', true),
  ('home', 'Smothered chicken with rice and gravy', 'southern', true),
  ('home', 'Mediterranean chicken gyro bowls', 'mediterranean', true),
  ('home', 'Seafood boil: shrimp, crab, corn and potatoes', 'seafood', true),
  ('home', 'Loaded baked potato bar', 'american', true),
  ('home', 'Honey glazed pork chops and mashed potatoes', 'southern', false),
  ('home', 'Slow cooker pulled pork sandwiches', 'bbq', false),
  ('home', 'BBQ baby back ribs and mac and cheese', 'bbq', false),
  ('home', 'Breakfast for dinner: pancakes, eggs and bacon', 'breakfast', false),
  ('home', 'Carnitas tacos', 'mexican', false),
  ('home', 'Pepperoni pizza night', 'italian', false),
  ('restaurant', 'Sushi night', 'asian', true),
  ('restaurant', 'Wings and fries', 'american', true),
  ('restaurant', 'Hibachi grill', 'asian', true),
  ('restaurant', 'Soul food spot', 'southern', true),
  ('restaurant', 'Neighborhood pizza', 'italian', true),
  ('restaurant', 'Taco shop', 'mexican', true),
  ('restaurant', 'Thai takeout', 'asian', true),
  ('restaurant', 'Steakhouse date', 'american', true),
  ('restaurant', 'Brunch spot', 'breakfast', true),
  ('restaurant', 'Ethiopian feast', 'african', true),
  ('restaurant', 'Caribbean jerk chicken', 'caribbean', true),
  ('restaurant', 'BBQ joint: ribs and brisket', 'bbq', false),
  ('restaurant', 'Ramen bar (tonkotsu)', 'asian', false)
) as v(kind, title, cuisine, pork_free)
on conflict (title) where couple_id is null do nothing;

-- ---------------------------------------------------------------------
-- 3. Per-couple defaults (coupons + date ideas), created once on demand
-- ---------------------------------------------------------------------
create or replace function public.ensure_couple_defaults()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_couple uuid := public.my_couple_id();
begin
  if v_couple is null then return; end if;

  if not exists (select 1 from public.coupons where couple_id = v_couple) then
    insert into public.coupons (couple_id, title, emoji, description, cost_coins, created_by) values
      (v_couple, '30-minute massage',       '💆', 'No phone, full attention, your choice of oil.', 60, null),
      (v_couple, 'Automatic movie pick',    '🎬', 'You pick the movie. No vetoes, no sighing.',   25, null),
      (v_couple, 'Breakfast in bed',        '🥞', 'Served, plated and cleaned up after.',          50, null),
      (v_couple, 'Skip one chore',          '🧹', 'Your partner does one chore of your choice.',   40, null),
      (v_couple, 'Restaurant of your choice','🍽️','Date night anywhere you want.',                120, null),
      (v_couple, 'Sleep in, no questions',  '😴', 'A full morning to sleep with zero guilt.',      45, null),
      (v_couple, 'Playlist control',        '🎧', 'Aux cord is yours for the whole drive.',        15, null),
      (v_couple, 'Win one argument',        '🏳️', 'Redeem to be right. Once. Use wisely.',       150, null);
  end if;

  if not exists (select 1 from public.date_ideas where couple_id = v_couple) then
    insert into public.date_ideas (couple_id, title, emoji, category, created_by) values
      (v_couple, 'Picnic in the park',        '🧺', 'outdoors', null),
      (v_couple, 'Cook a new recipe together','👩‍🍳', 'home', null),
      (v_couple, 'Movie marathon fort',       '🎞️', 'home', null),
      (v_couple, 'Comedy show',               '🎤', 'out', null),
      (v_couple, 'Arcade or bowling',         '🎳', 'out', null),
      (v_couple, 'Sunset drive + dessert',    '🌅', 'out', null),
      (v_couple, 'Museum or art walk',        '🖼️', 'out', null),
      (v_couple, 'Spa night at home',         '🛁', 'home', null),
      (v_couple, 'Try a new restaurant',      '🍜', 'food', null),
      (v_couple, 'Game night, loser cooks',   '🎲', 'home', null);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. Daily question: get today's card, or deal a fresh one
-- ---------------------------------------------------------------------
create or replace function public.get_daily_question(
  p_date date default current_date,
  p_category public.question_category default null,
  p_new boolean default false
)
returns table (assignment_id uuid, question_id bigint, category public.question_category, prompt text, for_date date)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_couple uuid := public.my_couple_id();
  v_assignment uuid;
  v_cat public.question_category;
  v_qid bigint;
  v_cats public.question_category[] := array['fun', 'deep', 'spicy', 'future']::public.question_category[];
begin
  if v_couple is null then raise exception 'pair with your partner first'; end if;
  if p_date not between current_date - 2 and current_date + 2 then
    raise exception 'date out of range';                      -- allows for time zones, blocks farming
  end if;

  -- Serialise the two phones opening the app at the same moment.
  perform pg_advisory_xact_lock(hashtext(v_couple::text || p_date::text));

  if not p_new then
    select a.id into v_assignment
    from public.question_assignments a
    where a.couple_id = v_couple and a.for_date = p_date
    order by a.created_at desc limit 1;
  else
    -- At most 3 dealt cards per day.
    if (select count(*) from public.question_assignments a where a.couple_id = v_couple and a.for_date = p_date) >= 3 then
      raise exception 'that''s 3 questions today, come back tomorrow';
    end if;
  end if;

  if v_assignment is null then
    v_cat := coalesce(p_category, v_cats[1 + ((p_date - date '2026-01-01') % 4 + 4) % 4]);

    select q.id into v_qid
    from public.daily_questions q
    where q.active and q.category = v_cat
      and not exists (select 1 from public.question_assignments a where a.couple_id = v_couple and a.question_id = q.id)
    order by random() limit 1;

    if v_qid is null then                                     -- deck exhausted: allow repeats
      select q.id into v_qid from public.daily_questions q
      where q.active and q.category = v_cat order by random() limit 1;
    end if;
    if v_qid is null then raise exception 'no questions in this category'; end if;

    insert into public.question_assignments (couple_id, question_id, for_date)
    values (v_couple, v_qid, p_date)
    on conflict (couple_id, for_date, question_id) do update set for_date = excluded.for_date
    returning id into v_assignment;
  end if;

  return query
    select a.id, q.id, q.category, q.prompt, a.for_date
    from public.question_assignments a
    join public.daily_questions q on q.id = a.question_id
    where a.id = v_assignment;
end $$;

-- Who has answered, without revealing the partner's text.
create or replace function public.question_state(p_assignment_id uuid)
returns table (my_answered boolean, partner_answered boolean, unlocked boolean)
language sql stable security definer set search_path = '' as $$
  select
    exists (select 1 from public.question_answers where assignment_id = p_assignment_id and user_id = auth.uid()),
    exists (select 1 from public.question_answers where assignment_id = p_assignment_id and user_id <> auth.uid()),
    (select count(distinct user_id) >= 2 from public.question_answers where assignment_id = p_assignment_id)
  where exists (
    select 1 from public.question_assignments a
    where a.id = p_assignment_id and a.couple_id = public.my_couple_id()
  )
$$;

-- ---------------------------------------------------------------------
-- 5. Dinner deck: mirror the Restaurants wishlist into swipeable cards
-- ---------------------------------------------------------------------
create or replace function public.sync_restaurant_meals()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_couple uuid := public.my_couple_id();
  v_count integer;
begin
  if v_couple is null then return 0; end if;
  insert into public.meal_options (couple_id, kind, title, cuisine, image_url, wishlist_item_id, created_by)
  select v_couple, 'restaurant', left(i.title, 120), coalesce(i.metadata ->> 'cuisine', 'restaurant'), i.image_url, i.id, i.created_by
  from public.wishlist_items i
  join public.wishlist_boards b on b.id = i.board_id
  where b.couple_id = v_couple and b.kind = 'restaurants'
    and not exists (select 1 from public.meal_options m where m.wishlist_item_id = i.id);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------
revoke all on function public.ensure_couple_defaults() from public, anon;
revoke all on function public.get_daily_question(date, public.question_category, boolean) from public, anon;
revoke all on function public.question_state(uuid) from public, anon;
revoke all on function public.sync_restaurant_meals() from public, anon;
grant execute on function public.ensure_couple_defaults() to authenticated;
grant execute on function public.get_daily_question(date, public.question_category, boolean) to authenticated;
grant execute on function public.question_state(uuid) to authenticated;
grant execute on function public.sync_restaurant_meals() to authenticated;

-- Voice notes and polaroids: let either partner mark a note listened and
-- edit captions, but never re-point a row at someone else's file.
revoke update on public.voice_notes from authenticated;
grant update (listened_at, transcript) on public.voice_notes to authenticated;
revoke update on public.memories from authenticated;
grant update (caption) on public.memories to authenticated;

-- Tasks: status flow is enforced here so the UI can't skip steps.
create or replace function public.guard_task_flow()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;            -- service role / SQL editor
  if new.status = old.status then return new; end if;
  if old.status = 'open' and new.status = 'claimed' then
    new.claimed_by := auth.uid();
  elsif old.status = 'claimed' and new.status = 'open' then
    if old.claimed_by <> auth.uid() then raise exception 'only the person who claimed it can drop it'; end if;
    new.claimed_by := null;
  elsif old.status = 'claimed' and new.status = 'done' then
    if old.claimed_by <> auth.uid() then raise exception 'only the person who claimed it can finish it'; end if;
    new.completed_at := now();
  elsif old.status = 'done' and new.status = 'approved' then
    new.approved_by := auth.uid();                          -- award_task_coins() checks it is the partner
  elsif old.status = 'done' and new.status = 'claimed' then
    if old.claimed_by = auth.uid() then raise exception 'your partner has to send it back'; end if;
    new.completed_at := null;                               -- partner sends it back
  else
    raise exception 'cannot move a task from % to %', old.status, new.status;
  end if;
  return new;
end $$;

drop trigger if exists tasks_flow on public.tasks;
create trigger tasks_flow
  before update of status on public.tasks
  for each row execute function public.guard_task_flow();
revoke all on function public.guard_task_flow() from public, anon, authenticated;

-- Trigger order matters: tasks_award must see approved_by set by tasks_flow.
-- Postgres fires same-event triggers alphabetically: tasks_award < tasks_flow,
-- so rename the award trigger to run second.
drop trigger if exists tasks_award on public.tasks;
drop trigger if exists tasks_zz_award on public.tasks;
create trigger tasks_zz_award
  before update of status on public.tasks
  for each row execute function public.award_task_coins();

-- End of Phase 2 migration.
