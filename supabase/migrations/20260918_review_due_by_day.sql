-- Review cards are due by DAY, and the exam clamp no longer crushes intervals.
--
-- Two things were wrong in card_mastery for review-state cards:
--   1. due_date carried the exact review time plus the interval, so a card
--      reviewed at 2:45 pm was due at 2:45 pm N days later and the page
--      counted down the minutes.
--   2. interval_days had been squashed into "half the runway before the
--      sweep week": stability 16 -> 5 days, stability 4.7 -> 5 days.
--
-- This recomputes both, per card, exactly as the corrected client does:
--   interval  = min( FSRS interval at the app's 90% retention, which is the
--                    stability in days, rounded ; days until the card's exam )
--               floored at 1
--   due_date  = local midnight of (the day it was last reviewed + interval)
-- The card's exam is its unit's test if that is still ahead, otherwise the
-- final (the same rule as nextExamFor in lib/exam-scheduler.js); with no
-- exam date the FSRS interval stands. Learning and relearning rows are not
-- touched: their steps are minutes. NUR116 and NUR118 are not touched.
--
-- The FSRS memory state (stability, difficulty, lapses) is never changed.
-- Scoped to one user per call, so it can be run for whoever needs it.

create or replace function public.renormalize_review_due(p_user uuid, p_tz text default 'America/New_York')
returns table(card_id bigint, course text, stability double precision,
              old_interval int, new_interval int, old_due timestamptz, new_due timestamptz)
language plpgsql as $$
declare v_today date := (now() at time zone p_tz)::date;
begin
  return query
  with base as (
    select cm.card_id, f.course, f.objective_ids, cm.stability, cm.last_reviewed_at,
           cm.due_date, cm.interval_days
    from public.card_mastery cm
    join public.flashcards f on f.id = cm.card_id
    where cm.user_id = p_user and cm.state = 'review'
      and f.course in ('NUR144', 'NUR146')
      and cm.stability is not null and cm.last_reviewed_at is not null
  ),
  unit as (
    select b.card_id,
           coalesce((select max(ou.unit) from public.objective_units ou
                     where ou.objective_id = any(b.objective_ids)), 1) as u
    from base b
  ),
  ex as (
    select b.card_id,
           (select es.exam_date from public.exam_schedule es
             where es.user_id = p_user and es.course = b.course and es.exam_date >= v_today
               and es.exam in ('unit' || u.u, 'final')
             order by case when es.exam = 'final' then 1 else 0 end, es.exam_date
             limit 1) as exam_date
    from base b join unit u on u.card_id = b.card_id
  ),
  calc as (
    select b.card_id,
           least(greatest(1, round(b.stability)::int),
                 case when e.exam_date is null then 2147483647
                      else greatest(1, e.exam_date - v_today) end) as new_interval
    from base b join ex e on e.card_id = b.card_id
  ),
  upd as (
    update public.card_mastery cm
       set interval_days = c.new_interval,
           due_date = ((date_trunc('day', cm.last_reviewed_at at time zone p_tz)
                        + c.new_interval * interval '1 day') at time zone p_tz)
      from calc c
     where cm.user_id = p_user and cm.card_id = c.card_id
     returning cm.card_id, cm.stability, cm.interval_days as new_interval, cm.due_date as new_due
  )
  select u.card_id, b.course, u.stability, b.interval_days, u.new_interval, b.due_date, u.new_due
  from upd u join base b on b.card_id = u.card_id
  order by u.card_id;
end $$;

-- the one user with review-state cards in a scheduled course at the time of writing
select count(*) as renormalized from public.renormalize_review_due('1fd9d85d-27b9-4cf1-9dc9-43e868b917dd', 'America/New_York');
