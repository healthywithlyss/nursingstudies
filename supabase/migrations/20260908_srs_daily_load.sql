-- Daily load control: how much new material to start each day, and the review
-- load the balancer levels toward.
--
-- Additive: one new table, no existing object touched.
--
-- Per (user, course) rather than per user. The caps are a statement about how
-- much of a particular subject someone can take on in a day, and a flashcard is
-- not the same unit of work as a quiz question — which is why there are two of
-- them rather than one combined number.
--
-- The defaults match lib/exam-scheduler.js DEFAULT_SETTINGS. A row is only
-- written when something is changed, so an untouched course runs on the code
-- defaults and there is no seeding step to keep in step with them.
create table if not exists public.srs_settings (
  user_id             uuid not null references auth.users(id) on delete cascade,
  course              text not null,
  new_cards_per_day   integer not null default 20  check (new_cards_per_day between 0 and 500),
  new_quiz_per_day    integer not null default 15  check (new_quiz_per_day  between 0 and 500),
  -- Not a hard cut: reviews that are genuinely due are still due, and the sweep
  -- overrides it outright. It is what the balancer aims under and what the
  -- forecast marks days against.
  daily_ceiling       integer not null default 120 check (daily_ceiling     between 5 and 2000),
  updated_at          timestamptz not null default now(),
  primary key (user_id, course)
);

alter table public.srs_settings enable row level security;

drop policy if exists srs_settings_own on public.srs_settings;
create policy srs_settings_own on public.srs_settings
  for all to authenticated
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());
