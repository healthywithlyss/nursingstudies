-- Quiz questions leave spaced repetition; missed ones become flashcards.
--
-- Additive: three new columns on existing tables, one new table. No existing
-- column is rewritten and no progress is reset. A question already answered
-- correctly is not retroactively retired — retirement is stamped the next time
-- it is answered, so nothing changes underneath a live queue.

-- ── 1. retirement ───────────────────────────────────────────────────────────
-- A quiz question is an assessment, not a study tool. Once it has been answered
-- correctly it has done its job, and scheduling 1,500 of them forever treats
-- the two as the same thing. retired_at is when that happened.
alter table public.question_mastery
  add column if not exists retired_at timestamptz;

-- the live queue is "my questions that have not retired"
create index if not exists question_mastery_live_idx
  on public.question_mastery (user_id) where retired_at is null;

-- ── 2. where a generated card came from ─────────────────────────────────────
-- auto_generated separates them from hand-written cards so they can be managed
-- in bulk; source_question_id is what makes generating a second card from the
-- same question impossible.
alter table public.flashcards
  add column if not exists auto_generated boolean not null default false,
  add column if not exists source_question_id bigint references public.quiz_questions(id) on delete set null;

create index if not exists flashcards_source_q_idx
  on public.flashcards (source_question_id) where source_question_id is not null;

-- ── 3. the review queue ─────────────────────────────────────────────────────
-- Suggestions land here, not in flashcards. Auto-generated content entering the
-- deck unreviewed is how a deck fills with junk, so nothing becomes a card
-- until it is accepted, and rejecting one is remembered (the unique constraint)
-- so the same question cannot propose itself again.
create table if not exists public.card_suggestions (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  question_id  bigint not null references public.quiz_questions(id) on delete cascade,
  course       text not null,
  objective_ids text[] not null default '{}',
  fact_tested  text not null,
  front        text not null,
  back         text not null,
  explanation  text,
  status       text not null default 'pending' check (status in ('pending','accepted','rejected')),
  card_id      bigint references public.flashcards(id) on delete set null,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  unique (user_id, question_id)
);

alter table public.card_suggestions enable row level security;

drop policy if exists card_suggestions_own on public.card_suggestions;
create policy card_suggestions_own on public.card_suggestions
  for all to authenticated
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── 4. passed-unit allowance ────────────────────────────────────────────────
-- Once a unit's test is behind her, its material still has to be maintained for
-- the final. A ceiling, not a quota: if less is due, the day is shorter.
alter table public.srs_settings
  add column if not exists passed_unit_cards_per_day integer not null default 20
    check (passed_unit_cards_per_day between 0 and 500);
