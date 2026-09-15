-- Podcast episodes generated from FLASHCARDS as a two-voice conversation.
--
-- The lecture format narrates a guide section; this one prepares her for a
-- deck: mechanism talk, the card's question asked aloud, 4.5 seconds of real
-- silence, then the answer. An episode of this format records which cards it
-- covers and which objective it was built for, so the Listen library and the
-- Podcast page can tell the two apart. Additive: existing rows default to
-- format 'lecture' and keep behaving as they do today.

alter table public.podcast_episodes
  add column if not exists format       text not null default 'lecture',  -- 'lecture' | 'dialogue'
  add column if not exists objective_id text,
  add column if not exists card_ids     bigint[],
  add column if not exists part         int,
  add column if not exists parts        int;

-- the second voice of a conversation, pinned per lecture like the narrator
alter table public.podcast_lecture_voice
  add column if not exists learner_voice text;
