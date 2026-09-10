-- Sweep windows, per exam kind.
--
-- Seven days does not survive contact with a real unit. 600 flashcards in seven
-- days is 86 a day on top of everything else, and the final's sweep covers both
-- units, so 1,200 cards is 172 a day. Widening the window keeps the "see every
-- item at least once" guarantee — which a retention threshold would not — and
-- brings the rate down to roughly 40 a day, which is followable.
--
--   unit sweeps   15 days   600 cards -> 40/day
--   final sweep   30 days  1,200 cards -> 40/day
--
-- Additive: two columns with defaults. Nothing is rewritten.
alter table public.srs_settings
  add column if not exists sweep_days_unit  integer not null default 15
    check (sweep_days_unit between 1 and 60),
  add column if not exists sweep_days_final integer not null default 30
    check (sweep_days_final between 1 and 90);
