-- Mastery counters and the is_mastered flag become a function of the attempt
-- history, computed where the history lives.
--
-- WHY THIS IS A TRIGGER AND NOT A CLIENT CHANGE
--
-- 1. is_mastered was never a measure of knowledge. The client set it from
--    sess.cardState, which startSession() resets to all-unseen every sitting
--    and resumeSession() seeds from localStorage, never from this table. So the
--    first correct answer in any new session set it true — which is why 960 of
--    961 "mastered" cards had exactly one correct answer. It could not converge
--    on anything, because it was measuring "since this browser last cleared
--    localStorage", not "do you know this".
--
-- 2. total_attempts and total_correct were never written to card_mastery AT
--    ALL. Not by the legacy loop, not by the SRS loop. They sat at 0 on every
--    one of 1,311 rows, which silently killed five features that read them
--    (Trouble Spots on both banks, the "attempted" count, the quiz builder's
--    "wrong" filter, and the front-loading of previously-missed questions).
--    Backfilling them once would have frozen them again from the next rating.
--
-- Both loops — the legacy flashcard session and the FSRS session — insert into
-- card_attempts. So the attempt tables are the one place every rating passes
-- through, and deriving from them covers every writer, present and future.
--
-- THE RULE
--   is_mastered = total_correct >= 2 AND the two most recent attempts were both
--                 correct.
-- Stated in the UI as "last two correct", because that is what it means.
--
-- NOBODY'S DASHBOARD CHANGES ON DEPLOY. This alters how the flag is COMPUTED
-- from the next rating onward; it rewrites no existing row. A card corrects
-- itself the first time it is touched, and a user's count converges over the
-- following weeks rather than dropping overnight.
--
-- The FSRS columns (state, stability, difficulty, due_date, learning_step,
-- interval_days, repetitions, lapses) are NOT touched by these triggers. They
-- belong to the scheduler and are written by the app.

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
  v_last_two_ok boolean;
begin
  select count(*), count(*) filter (where result = 'got_it'), max(created_at)
    into v_total, v_correct, v_last_at
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
     is_mastered, last_result, last_attempted_at)
  values
    (new.user_id, new.card_id, v_total, v_correct, v_consec,
     (v_correct >= 2 and v_last_two_ok), v_last, v_last_at)
  on conflict (user_id, card_id) do update set
    total_attempts      = excluded.total_attempts,
    total_correct       = excluded.total_correct,
    consecutive_correct = excluded.consecutive_correct,
    is_mastered         = excluded.is_mastered,
    last_result         = excluded.last_result,
    last_attempted_at   = excluded.last_attempted_at;

  return null;
end $$;

create or replace function public.refresh_question_mastery_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total   int;
  v_correct int;
  v_consec  int;
  v_last_at timestamptz;
  v_last_two_ok boolean;
begin
  select count(*), count(*) filter (where is_correct), max(created_at)
    into v_total, v_correct, v_last_at
  from quiz_attempts
  where user_id = new.user_id and question_id = new.question_id;

  select count(*) into v_consec
  from (
    select is_correct,
           row_number() over (order by created_at desc, id desc) as rn
    from quiz_attempts
    where user_id = new.user_id and question_id = new.question_id
  ) t
  where rn <= coalesce(
    (select min(rn) from (
       select row_number() over (order by created_at desc, id desc) as rn, is_correct
       from quiz_attempts
       where user_id = new.user_id and question_id = new.question_id
     ) u where not u.is_correct), 2147483647) - 1;

  select coalesce(bool_and(is_correct), false) into v_last_two_ok
  from (
    select is_correct from quiz_attempts
    where user_id = new.user_id and question_id = new.question_id
    order by created_at desc, id desc
    limit 2
  ) t2;

  insert into question_mastery as m
    (user_id, question_id, total_attempts, total_correct, consecutive_correct,
     is_mastered, last_attempted_at)
  values
    (new.user_id, new.question_id, v_total, v_correct, v_consec,
     (v_correct >= 2 and v_last_two_ok), v_last_at)
  on conflict (user_id, question_id) do update set
    total_attempts      = excluded.total_attempts,
    total_correct       = excluded.total_correct,
    consecutive_correct = excluded.consecutive_correct,
    is_mastered         = excluded.is_mastered,
    last_attempted_at   = excluded.last_attempted_at;

  return null;
end $$;

drop trigger if exists card_attempts_refresh_mastery on public.card_attempts;
create trigger card_attempts_refresh_mastery
  after insert on public.card_attempts
  for each row execute function public.refresh_card_mastery_counts();

drop trigger if exists quiz_attempts_refresh_mastery on public.quiz_attempts;
create trigger quiz_attempts_refresh_mastery
  after insert on public.quiz_attempts
  for each row execute function public.refresh_question_mastery_counts();
