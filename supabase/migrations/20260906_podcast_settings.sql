-- Per-user player settings. Additive; nothing existing is touched.
--
-- A separate table from podcast_progress because progress is per user PER
-- EPISODE, while volume is one setting for the person. Putting it on
-- podcast_progress would store the same value once per episode and leave no
-- answer for "what is her volume before she has played anything".
create table if not exists public.podcast_settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  volume     numeric not null default 1 check (volume >= 0 and volume <= 1),
  muted      boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.podcast_settings enable row level security;

-- own row only, no admin exception: a listening volume is not something an
-- admin has any reason to read. Same shape as podcast_progress.
drop policy if exists podcast_settings_own on public.podcast_settings;
create policy podcast_settings_own on public.podcast_settings
  for all to authenticated
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());
