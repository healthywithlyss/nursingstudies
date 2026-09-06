-- Phase 2 — audio generation and playback.
--
-- Additive only. No existing table is altered, no data is touched. The one
-- change to an existing object is a new SELECT policy on podcast_episodes and
-- podcast_checkpoints: today those are admin-only for every command including
-- SELECT, and the listener page has to be usable by any signed-in student.
-- Writes stay admin-only, exactly as they are now.

-- ────────────────────────────────────────────────────────────── audio segments
create table if not exists public.podcast_audio (
  id               uuid primary key default gen_random_uuid(),
  episode_id       uuid not null references public.podcast_episodes(id) on delete cascade,
  ordinal          integer not null default 0,
  storage_path     text    not null,
  duration_seconds numeric not null default 0,
  voice            text    not null,
  model            text    not null,
  created_at       timestamptz not null default now(),

  -- needed to line the audio up with the script and the checkpoints
  char_start       integer not null default 0,
  char_end         integer not null default 0,
  -- ordinal of the checkpoint this segment ends on; null = end of episode, or
  -- a split forced by the per-request duration cap rather than by a question
  ends_at_checkpoint integer,
  bytes            integer not null default 0,
  mime_type        text    not null default 'audio/wav',

  unique (episode_id, ordinal)
);

create index if not exists podcast_audio_episode_idx
  on public.podcast_audio (episode_id, ordinal);

alter table public.podcast_audio enable row level security;

-- writes: admin only, same shape as podcast_episodes / podcast_checkpoints
drop policy if exists podcast_audio_admin_all on public.podcast_audio;
create policy podcast_audio_admin_all on public.podcast_audio
  for all
  using      (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'))
  with check (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- reads: any signed-in student, because this is what playback needs
drop policy if exists podcast_audio_read_authenticated on public.podcast_audio;
create policy podcast_audio_read_authenticated on public.podcast_audio
  for select to authenticated
  using (true);

-- ───────────────────────────────────────────────────────────── playback position
-- A new table rather than a column on podcast_episodes: position is per USER,
-- and podcast_episodes has one row per episode shared by everyone. A column
-- there would have every listener overwriting the same value.
create table if not exists public.podcast_progress (
  user_id          uuid not null references auth.users(id) on delete cascade,
  episode_id       uuid not null references public.podcast_episodes(id) on delete cascade,
  segment_ordinal  integer not null default 0,
  position_seconds numeric not null default 0,
  completed        boolean not null default false,
  updated_at       timestamptz not null default now(),
  primary key (user_id, episode_id)
);

alter table public.podcast_progress enable row level security;

-- each user sees and writes only their own row; no admin exception, because a
-- listening position is not something an admin has any reason to read
drop policy if exists podcast_progress_own on public.podcast_progress;
create policy podcast_progress_own on public.podcast_progress
  for all to authenticated
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ─────────────────────────────────── read access to episodes for the listener
-- ADDITIVE: these grant SELECT only. The existing admin-all policies are left
-- exactly as they are, so inserts, updates and deletes remain admin-only.
drop policy if exists podcast_episodes_read_authenticated on public.podcast_episodes;
create policy podcast_episodes_read_authenticated on public.podcast_episodes
  for select to authenticated
  using (true);

drop policy if exists podcast_checkpoints_read_authenticated on public.podcast_checkpoints;
create policy podcast_checkpoints_read_authenticated on public.podcast_checkpoints
  for select to authenticated
  using (true);

-- ──────────────────────────────────────────────────────────────────── storage
-- Private bucket. The listener page mints a short-lived signed URL per segment,
-- because an <audio src> cannot send an Authorization header, and a public
-- bucket would put the audio behind a guessable URL with no auth at all.
insert into storage.buckets (id, name, public)
values ('podcast-audio', 'podcast-audio', false)
on conflict (id) do nothing;

drop policy if exists podcast_audio_obj_read on storage.objects;
create policy podcast_audio_obj_read on storage.objects
  for select to authenticated
  using (bucket_id = 'podcast-audio');

drop policy if exists podcast_audio_obj_write on storage.objects;
create policy podcast_audio_obj_write on storage.objects
  for all to authenticated
  using      (bucket_id = 'podcast-audio' and exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'))
  with check (bucket_id = 'podcast-audio' and exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));
