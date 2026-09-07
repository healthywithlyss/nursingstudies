-- Pin the narrator voice per lecture, and record token usage per generated call.
--
-- Additive only: one new table, two new nullable columns. No existing row is
-- read, written, or deleted, and no existing policy is changed.

-- ───────────────────────────────────────────────────────── voice, pinned per guide
-- The narrator belongs to the LECTURE, not to whatever the dropdown happened to
-- say when a batch started. Lecture 1 came out as nine sections of Kore, eight of
-- Charon, one of Zephyr, and one section — HIATAL HERNIA — that changes narrator
-- partway through, because the client sent the voice with every request and the
-- client's state drifted between batches.
--
-- Keeping it in the database rather than in the page makes the drift impossible
-- rather than merely unlikely: the function reads the pin and ignores what it
-- was asked for. A client-side fix would just be a new place for the same bug.
create table if not exists public.podcast_lecture_voice (
  guide_slug text primary key,
  voice      text not null,
  pinned_at  timestamptz not null default now(),
  pinned_by  uuid references auth.users(id) on delete set null
);

alter table public.podcast_lecture_voice enable row level security;

-- writes: admin only, same shape as every other podcast write
drop policy if exists podcast_lecture_voice_admin_all on public.podcast_lecture_voice;
create policy podcast_lecture_voice_admin_all on public.podcast_lecture_voice
  for all
  using      (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'))
  with check (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- reads: any signed-in student, so the listener can name its narrator
drop policy if exists podcast_lecture_voice_read_authenticated on public.podcast_lecture_voice;
create policy podcast_lecture_voice_read_authenticated on public.podcast_lecture_voice
  for select to authenticated
  using (true);

-- Backfill from what is already on disk, so existing lectures are pinned to the
-- voice that most of their audio is actually in rather than to a default. The
-- odd section out stays as it is; nothing is regenerated here.
insert into public.podcast_lecture_voice (guide_slug, voice)
select distinct on (t.guide_slug) t.guide_slug, t.voice
from (
  select e.guide_slug, a.voice, count(*) as n
  from public.podcast_audio a
  join public.podcast_episodes e on e.id = a.episode_id
  group by e.guide_slug, a.voice
) t
order by t.guide_slug, t.n desc, t.voice
on conflict (guide_slug) do nothing;

-- ─────────────────────────────────────────────────────────────── measured cost
-- The functions already computed a usage block per call and then dropped it on
-- the floor, so the first full lecture cost whatever it cost and there is no
-- record of it. These columns are where the next run gets measured.
alter table public.podcast_audio
  add column if not exists usage jsonb;

alter table public.podcast_episodes
  add column if not exists usage jsonb;
