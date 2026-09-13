-- When was each card first shown to each student?
--
-- WHY. The "new cards per day" limit was applied fresh on every render: it
-- took the never-seen cards and offered the first 30, with no memory of how
-- many new cards had already been started today. One student started 36 new
-- cards against a limit of 30 and was still being offered 30 more. A daily
-- budget needs to know what was introduced today, and nothing recorded it.
--
-- introduced_at is the time of a card's first attempt by that student. The
-- attempt trigger sets it on the first attempt and never moves it after;
-- the app also stamps it on the first rating so the panel is right before
-- a reload. Backfilled from the earliest attempt for everyone. Additive:
-- nothing else in any row changes, and nothing reads the column yet except
-- the new daily budget.

alter table public.card_mastery add column if not exists introduced_at timestamptz;

create or replace function public.refresh_card_mastery_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total   int;
  v_correct int;
  v_consec  int;
  v_last    text;
  v_last_at timestamptz;
  v_first_at timestamptz;
  v_last_two_ok boolean;
begin
  select count(*), count(*) filter (where result = 'got_it'), max(created_at), min(created_at)
    into v_total, v_correct, v_last_at, v_first_at
  from card_attempts
  where user_id = new.user_id and card_id = new.card_id;

  -- most recent result
  select result into v_last
  from card_attempts
  where user_id = new.user_id and card_id = new.card_id
  order by created_at desc, id desc
  limit 1;

  -- trailing run of correct answers
  select count(*) into v_consec
  from (
    select result,
           row_number() over (order by created_at desc, id desc) as rn
    from card_attempts
    where user_id = new.user_id and card_id = new.card_id
  ) t
  where rn <= coalesce(
    (select min(rn) from (
       select row_number() over (order by created_at desc, id desc) as rn, result
       from card_attempts
       where user_id = new.user_id and card_id = new.card_id
     ) u where u.result <> 'got_it'), 2147483647) - 1;

  -- the two most recent attempts, both correct
  select coalesce(bool_and(result = 'got_it'), false) into v_last_two_ok
  from (
    select result from card_attempts
    where user_id = new.user_id and card_id = new.card_id
    order by created_at desc, id desc
    limit 2
  ) t2;

  insert into card_mastery as m
    (user_id, card_id, total_attempts, total_correct, consecutive_correct,
     is_mastered, last_result, last_attempted_at, introduced_at)
  values
    (new.user_id, new.card_id, v_total, v_correct, v_consec,
     (v_correct >= 2 and v_last_two_ok), v_last, v_last_at, v_first_at)
  on conflict (user_id, card_id) do update set
    total_attempts      = excluded.total_attempts,
    total_correct       = excluded.total_correct,
    consecutive_correct = excluded.consecutive_correct,
    is_mastered         = excluded.is_mastered,
    last_result         = excluded.last_result,
    last_attempted_at   = excluded.last_attempted_at,
    -- first attempt ever; once set it never moves
    introduced_at       = coalesce(m.introduced_at, excluded.introduced_at);

  return null;
end $$;

-- backfill from the attempt history: the first attempt ever, per student and card
update public.card_mastery m
   set introduced_at = x.first_at
  from (select user_id, card_id, min(created_at) first_at
          from public.card_attempts group by user_id, card_id) x
 where x.user_id = m.user_id and x.card_id = m.card_id
   and m.introduced_at is null;
