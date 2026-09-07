-- Real spaced repetition across flashcards AND quiz questions, scheduled
-- around exam dates.
--
-- Additive only. No existing column is dropped or rewritten, no progress is
-- reset, no row is deleted. The three legacy counters (consecutive_correct,
-- total_correct, total_attempts, is_mastered) are left exactly as they are so
-- every existing screen keeps working while the new scheduler runs beside them.

-- ─────────────────────────────────────────────── FSRS state, on BOTH tables
-- due_date is a timestamptz rather than a date because FSRS learning steps are
-- sub-day: an item rated Again comes back in a minute, in the same sitting,
-- not tomorrow. interval_days carries the whole-day figure a person reads.
--
-- learning_step is not in the original spec but the reference implementation
-- needs it: the learning ladder is (1 min, 10 min) and without knowing which
-- rung an item is on, a Good either graduates too early or never graduates.
do $$
declare t text;
begin
  foreach t in array array['card_mastery','question_mastery'] loop
    execute format('alter table public.%I
      add column if not exists due_date         timestamptz,
      add column if not exists stability        double precision,
      add column if not exists difficulty       double precision,
      add column if not exists interval_days    integer not null default 0,
      add column if not exists repetitions      integer not null default 0,
      add column if not exists lapses           integer not null default 0,
      add column if not exists last_reviewed_at timestamptz,
      add column if not exists learning_step    smallint,
      add column if not exists state            text not null default ''new''', t);
    execute format('alter table public.%I drop constraint if exists %I', t, t||'_state_chk');
    execute format('alter table public.%I add constraint %I
      check (state in (''new'',''learning'',''review'',''relearning''))', t, t||'_state_chk');
    -- the queue is "my rows, ordered by due" and nothing else
    execute format('create index if not exists %I on public.%I (user_id, due_date)',
      t||'_due_idx', t);
  end loop;
end $$;

-- ──────────────────────────────────────────────────────────── exam dates
-- Per user: two students sitting the same course still sit it on their own
-- calendar. Three fixed rows per course — unit1, unit2, final — because the
-- structure is fixed and a general "add an exam" system would be a worse fit
-- for the only shape that actually occurs.
create table if not exists public.exam_schedule (
  user_id    uuid not null references auth.users(id) on delete cascade,
  course     text not null,
  exam       text not null check (exam in ('unit1','unit2','final')),
  exam_date  date,
  updated_at timestamptz not null default now(),
  primary key (user_id, course, exam)
);

alter table public.exam_schedule enable row level security;

drop policy if exists exam_schedule_own on public.exam_schedule;
create policy exam_schedule_own on public.exam_schedule
  for all to authenticated
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ───────────────────────────────────────────── which unit an objective is in
-- A property of the COURSE, not of a student, so one shared row per objective
-- rather than a copy per user. Reads are open to any signed-in user because
-- every readiness number depends on it; writes are admin-only, like every
-- other piece of course content.
create table if not exists public.objective_units (
  objective_id text primary key,
  course       text not null,
  unit         smallint not null default 1 check (unit in (1,2)),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);

alter table public.objective_units enable row level security;

drop policy if exists objective_units_read on public.objective_units;
create policy objective_units_read on public.objective_units
  for select to authenticated using (true);

drop policy if exists objective_units_admin_write on public.objective_units;
create policy objective_units_admin_write on public.objective_units
  for all
  using      (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'))
  with check (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- Seed every objective that exists anywhere — the objectives table, the ids
-- flashcards actually carry, and the ids quiz questions actually carry. Those
-- three namespaces do not agree with each other for NUR116 and NUR118 (a
-- flashcard says NUR116_T01, a quiz question says L1_01), so all three are
-- collected rather than trusting objectives alone.
--
-- Course is inferred with the same rule the app uses: N144* is NUR144,
-- NUR116*/N116T* is NUR116, everything else falls to NUR118.
-- Everything starts in unit 1, which is correct for NUR144 (N144_L1 and
-- N144_SKILLS are both unit 1; unit 2 is Psych and does not exist yet) and is
-- a starting point for the other two, which have no exam dates and therefore
-- no unit-dependent behaviour until one is set.
insert into public.objective_units (objective_id, course, unit)
select oid,
       case when oid like 'N144%' then 'NUR144'
            when oid like 'NUR116%' or oid like 'N116T%' then 'NUR116'
            else 'NUR118' end,
       1
from (
  select id as oid from public.objectives
  union
  select distinct unnest(objective_ids) from public.flashcards
  union
  select distinct objective_id from public.quiz_questions
) t
where oid is not null and oid <> ''
on conflict (objective_id) do nothing;

-- ───────────────────────────────────────────────────────────────── backfill
-- Every existing row gets FSRS state by REPLAYING its history through the
-- scheduler, rather than by inventing a mapping from streak counters to
-- stability. The replay is the model's own answer to "what would this item
-- look like if it had been scheduled properly all along", which is the only
-- defensible source for these numbers.
--
-- The history available is thin but unambiguous. card_mastery.total_attempts
-- and total_correct are 0 on every row — the app never wrote them — so the
-- real signal is consecutive_correct plus last_result, and every row's history
-- reduces to one of six cases. The values below were produced by running each
-- case through vendor/fsrs.js:
--
--   node -e "const F=require('./vendor/fsrs.js'),s=new F.Scheduler();
--            let c=F.newCard(),t=Date.parse('2026-01-01T00:00:00Z');
--            for(const r of RATINGS){c=s.review(c,r,t);t=c.due;} console.log(c)"
--
-- Ratings map from the existing three-button UI: got_it -> Good,
-- unsure -> Hard, missed -> Again. Quiz: correct -> Good, incorrect -> Again.
--
-- Note what this exposes: 960 of the 961 cards flagged is_mastered had exactly
-- ONE correct answer, because the old rule mastered a card the first time it
-- was answered correctly. Replaying that honestly leaves them in `learning`
-- with about 2.3 days of stability rather than pretending they are known. They
-- are not reset — their history is intact and counted — they are just no
-- longer described as mastered on the strength of a single answer.

update public.card_mastery set
  stability = v.s, difficulty = v.d, state = v.st, learning_step = v.step,
  interval_days = v.ivl, repetitions = v.reps, lapses = v.lapses,
  last_reviewed_at = coalesce(last_attempted_at, now()),
  due_date = coalesce(last_attempted_at, now()) + (v.due_min || ' minutes')::interval
from (values
  -- last_result, consecutive_correct floor, stability, difficulty, state, step, interval_days, reps, lapses, due offset (min)
  ('got_it', 3, 10.9710, 2.1043, 'review',   null::smallint, 11, 3, 0, 15840.0),
  ('got_it', 1,  2.3065, 2.1181, 'learning', 1::smallint,     0, 1, 0,    10.0),
  ('unsure', 0,  1.2931, 5.1122, 'learning', 0::smallint,     0, 1, 0,     5.5),
  ('missed', 0,  0.2120, 6.4133, 'learning', 0::smallint,     0, 1, 0,     1.0)
) as v(res, cc, s, d, st, step, ivl, reps, lapses, due_min)
where public.card_mastery.state = 'new'
  and coalesce(public.card_mastery.last_result, 'missed') = v.res
  and case
        when v.res = 'got_it' and coalesce(public.card_mastery.consecutive_correct,0) >= 3 then v.cc = 3
        when v.res = 'got_it' then v.cc = 1
        else v.cc = 0
      end;

-- anything with a last_result the four cases above do not name (there is none
-- today, but a future value must not be left silently unscheduled)
update public.card_mastery set
  stability = 0.2120, difficulty = 6.4133, state = 'learning', learning_step = 0,
  interval_days = 0, repetitions = greatest(coalesce(total_attempts,0), 1), lapses = 0,
  last_reviewed_at = coalesce(last_attempted_at, now()),
  due_date = coalesce(last_attempted_at, now()) + interval '1 minute'
where state = 'new';

update public.question_mastery set
  stability = case when last_result then 2.3065 else 0.2120 end,
  difficulty = case when last_result then 2.1181 else 6.4133 end,
  state = 'learning',
  learning_step = case when last_result then 1 else 0 end,
  interval_days = 0,
  repetitions = greatest(coalesce(total_attempts, 0), 1),
  lapses = case when last_result then 0 else 0 end,
  last_reviewed_at = coalesce(last_attempted_at, now()),
  due_date = coalesce(last_attempted_at, now())
             + (case when last_result then interval '10 minutes' else interval '1 minute' end)
where state = 'new';
