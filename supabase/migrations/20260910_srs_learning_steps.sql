-- Configurable learning and relearning steps.
--
-- Additive: two columns on srs_settings, both with defaults matching
-- lib/study-session.js, so an existing row keeps working without a backfill.
--
-- Minutes, in order. A new card passes each learning step before it graduates
-- to a real interval; a card you already knew and then failed goes through the
-- relearning steps instead. Defaults are Anki's: 1 then 10 for learning, 10 for
-- relearning.
alter table public.srs_settings
  add column if not exists learning_steps   integer[] not null default '{1,10}',
  add column if not exists relearning_steps integer[] not null default '{10}';

-- A check constraint cannot contain a subquery, so the per-element bounds live
-- in an immutable function. An empty ladder is rejected outright: a card with no
-- step to go to has nowhere to be.
create or replace function public.srs_steps_ok(steps integer[])
returns boolean language sql immutable as $$
  select steps is not null
     and array_length(steps, 1) between 1 and 6
     and not exists (
       select 1 from unnest(steps) s where s is null or s < 1 or s > 1440
     );
$$;

alter table public.srs_settings drop constraint if exists srs_settings_steps_chk;
alter table public.srs_settings add constraint srs_settings_steps_chk check (
  public.srs_steps_ok(learning_steps) and public.srs_steps_ok(relearning_steps)
);
