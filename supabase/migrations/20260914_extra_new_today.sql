-- "More new cards today", without touching the daily limit.
--
-- The daily limit is a standing setting. Some days she wants to go past it
-- once — the panel offers +5 / +10 / +20 for today only. The extra is stored
-- with the local date it was granted for, so tomorrow the plain limit is back
-- on its own. Additive: two columns on srs_settings, defaults keep every
-- existing row exactly as it behaves today.

alter table public.srs_settings
  add column if not exists extra_new int not null default 0,
  add column if not exists extra_new_date date;
