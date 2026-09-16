-- A conversation checkpoint tests one flashcard; record which. Additive.
alter table public.podcast_checkpoints add column if not exists card_id bigint;
