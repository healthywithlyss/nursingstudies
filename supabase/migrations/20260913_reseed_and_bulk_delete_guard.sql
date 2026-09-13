-- Re-seeds that keep history, and a guard on bulk deletes.
--
-- WHY. On 2026-09-12 the NUR144 Lecture 1 deck was rebuilt: 145 cards deleted,
-- 97 inserted. The flashcards were backed up; the attempt history was not, and
-- it is gone. Lectures 2-5 are coming and Lecture 1 will be revised again, so
-- this cannot be a one-off. Both guards live in the database because re-seeds
-- happen through SQL, and a script would be bypassed the moment either of us
-- wrote SQL directly. A function that takes its own snapshot cannot be run
-- without one.
--
-- 1. reseed_flashcards(course, objective, cards, dry_run)
--      - matches old cards to new ones by content (pg_trgm), one-to-one
--      - a match UPDATES the old row in place: same id, so card_mastery and
--        card_attempts are untouched and every student's history carries over
--      - a genuinely new card is inserted and starts fresh
--      - an old card with no match is ARCHIVED, history included, then removed
--      - refuses to run unless its snapshot of flashcards, card_mastery and
--        card_attempts (scoped to the deck) has been written first
--      - dry_run=true (the default) returns the plan and changes nothing
--
-- 2. guard_bulk_delete on the six content/history tables
--      A statement that deletes more than a handful is refused unless the
--      transaction has set app.bulk_delete_ok, which only the two sanctioned
--      paths do after snapshotting. The single-card deleteCard path in the app
--      is unaffected: on the history tables the guard counts DISTINCT cards,
--      not rows, so removing one card that twelve students rated still passes.
--
-- 3. bulk_delete_with_snapshot(table, where)
--      The sanctioned way to delete many rows outside a re-seed: snapshots
--      the matching rows to backup.<table>_bulk_<timestamp>, reports the count,
--      then deletes with the flag set.
--
-- Nothing here is callable from the app: execute is revoked from anon and
-- authenticated. These run as postgres, through the MCP or the SQL editor.

create extension if not exists pg_trgm with schema extensions;
create schema if not exists archive;
create schema if not exists backup;

-- ── archive: where a removed card's history goes instead of the bin ──────
create table if not exists archive.flashcards (
  like public.flashcards including defaults,
  reseed_id   bigint,
  archived_at timestamptz not null default now(),
  reason      text
);
create table if not exists archive.card_mastery (
  like public.card_mastery including defaults,
  reseed_id   bigint,
  archived_at timestamptz not null default now(),
  card_question text,
  card_answer   text
);
create table if not exists archive.card_attempts (
  like public.card_attempts including defaults,
  reseed_id   bigint,
  archived_at timestamptz not null default now()
);

-- ── the log: every re-seed and every sanctioned bulk delete ─────────────
create table if not exists public.reseed_log (
  id           bigserial primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  kind         text not null,                  -- 'reseed' | 'bulk_delete'
  course       text,
  objective    text,
  dry_run      boolean not null default false,
  snapshot     jsonb,                          -- {flashcards:'backup.x', ...}
  counts       jsonb,
  plan         jsonb,
  run_by       text not null default current_user
);
create table if not exists public.reseed_matches (
  reseed_id   bigint not null references public.reseed_log(id),
  old_card_id bigint,
  new_index   int,
  score       real,
  action      text not null,                   -- 'update' | 'insert' | 'archive'
  old_question text,
  new_question text
);
alter table public.reseed_log enable row level security;
alter table public.reseed_matches enable row level security;
revoke all on public.reseed_log, public.reseed_matches from anon, authenticated;

-- ── the bulk-delete guard ───────────────────────────────────────────────
-- TG_ARGV[0] is the column whose DISTINCT values are counted ('id' for the
-- content tables, 'card_id' / 'question_id' for history tables). TG_ARGV[1]
-- is the threshold.
create or replace function public.guard_bulk_delete()
returns trigger language plpgsql as $$
declare
  n bigint;
  col text := coalesce(TG_ARGV[0], 'id');
  lim int  := coalesce(TG_ARGV[1], '5')::int;
begin
  execute format('select count(distinct %I) from deleted', col) into n;
  if n > lim and coalesce(current_setting('app.bulk_delete_ok', true), '') <> 'true' then
    raise exception using
      errcode = 'check_violation',
      message = format('bulk delete refused: this statement removes %s distinct %s from %s (limit %s without a snapshot).',
                       n, col, TG_TABLE_NAME, lim),
      hint = format('Snapshot first. Use bulk_delete_with_snapshot(%L, %L) for an ad-hoc delete, or reseed_flashcards(...) to rebuild a deck with history preserved.',
                    TG_TABLE_NAME, '<where clause>');
  end if;
  return null;
end $$;

do $$
declare t record;
begin
  for t in select * from (values
      ('flashcards',       'id',          5),
      ('quiz_questions',   'id',          5),
      ('card_mastery',     'card_id',     5),
      ('card_attempts',    'card_id',     5),
      ('question_mastery', 'question_id', 5),
      ('quiz_attempts',    'question_id', 5)) as v(tbl, col, lim)
  loop
    execute format('drop trigger if exists %I on public.%I', t.tbl || '_bulk_delete_guard', t.tbl);
    execute format(
      'create trigger %I after delete on public.%I referencing old table as deleted
       for each statement execute function public.guard_bulk_delete(%L, %L)',
      t.tbl || '_bulk_delete_guard', t.tbl, t.col, t.lim::text);
  end loop;
end $$;

-- ── sanctioned ad-hoc bulk delete ───────────────────────────────────────
create or replace function public.bulk_delete_with_snapshot(p_table text, p_where text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  allowed text[] := array['flashcards','quiz_questions','card_mastery','card_attempts','question_mastery','quiz_attempts'];
  snap text; n bigint; log_id bigint;
begin
  if not (p_table = any(allowed)) then
    raise exception 'bulk_delete_with_snapshot: table % is not one of %', p_table, allowed;
  end if;
  if p_where is null or btrim(p_where) = '' then
    raise exception 'bulk_delete_with_snapshot: a WHERE clause is required; refusing to delete a whole table';
  end if;
  snap := format('%s_bulk_%s', p_table, to_char(clock_timestamp(), 'YYYYMMDD_HH24MISS'));
  execute format('create table backup.%I as select * from public.%I where %s', snap, p_table, p_where);
  execute format('select count(*) from backup.%I', snap) into n;
  if n = 0 then
    execute format('drop table backup.%I', snap);
    return jsonb_build_object('table', p_table, 'deleted', 0, 'note', 'nothing matched; no snapshot kept');
  end if;
  insert into reseed_log(kind, snapshot, counts, plan)
    values ('bulk_delete', jsonb_build_object(p_table, 'backup.' || snap),
            jsonb_build_object('to_delete', n), jsonb_build_object('where', p_where))
    returning id into log_id;
  perform set_config('app.bulk_delete_ok', 'true', true);
  execute format('delete from public.%I where %s', p_table, p_where);
  update reseed_log set finished_at = now() where id = log_id;
  return jsonb_build_object('table', p_table, 'deleted', n, 'snapshot', 'backup.' || snap, 'log_id', log_id);
end $$;

-- ── text normalisation for matching ─────────────────────────────────────
create or replace function public.reseed_norm(t text) returns text
language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- ── the re-seed ─────────────────────────────────────────────────────────
-- p_cards: jsonb array of {question, answer, explanation?, objective_ids?}.
-- Scope: cards in p_course whose objective_ids contain p_objective.
-- Score: 0.75 * trigram similarity of questions + 0.25 * of answers, with the
-- question part required to reach 0.4 on its own so an answer alone cannot
-- claim a match. Accepted at >= p_threshold, greedily by best score, one-to-one.
create or replace function public.reseed_flashcards(
  p_course text, p_objective text, p_cards jsonb,
  p_dry_run boolean default true, p_threshold real default 0.6)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  log_id bigint; r record; stamp text; snap jsonb;
  n_old int; n_new int; n_upd int := 0; n_ins int := 0; n_arch int := 0;
  arch_mastery int := 0; arch_attempts int := 0;
begin
  if jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards) = 0 then
    raise exception 'reseed_flashcards: p_cards must be a non-empty json array of {question, answer, ...}';
  end if;

  insert into reseed_log(kind, course, objective, dry_run)
    values ('reseed', p_course, p_objective, p_dry_run) returning id into log_id;

  -- the deck as it stands
  create temp table rs_old on commit drop as
    select f.id, f.question, f.answer, reseed_norm(f.question) nq, reseed_norm(f.answer) na
    from flashcards f where f.course = p_course and p_objective = any(f.objective_ids);
  select count(*) into n_old from rs_old;

  -- the deck as proposed
  create temp table rs_new on commit drop as
    select (ord - 1)::int idx,
           c->>'question' question, c->>'answer' answer, c->>'explanation' explanation,
           coalesce((select array_agg(x) from jsonb_array_elements_text(c->'objective_ids') x), array[p_objective]) objective_ids,
           reseed_norm(c->>'question') nq, reseed_norm(c->>'answer') na
    from jsonb_array_elements(p_cards) with ordinality as t(c, ord);
  select count(*) into n_new from rs_new;
  if exists (select 1 from rs_new where coalesce(question,'') = '' or coalesce(answer,'') = '') then
    raise exception 'reseed_flashcards: every card needs a non-empty question and answer';
  end if;

  -- score every pair, then take the best matches greedily, one-to-one
  create temp table rs_pairs on commit drop as
    select o.id old_id, n.idx,
           (case when o.nq = n.nq then 1.0 else similarity(o.nq, n.nq) end)::real q_sim,
           (case when o.na = n.na then 1.0 else similarity(o.na, n.na) end)::real a_sim
    from rs_old o cross join rs_new n;
  create temp table rs_match (old_id bigint primary key, idx int unique, score real) on commit drop;
  for r in
    select old_id, idx, (0.75 * q_sim + 0.25 * a_sim)::real score
    from rs_pairs where q_sim >= 0.4
    order by (0.75 * q_sim + 0.25 * a_sim) desc, old_id, idx
  loop
    exit when r.score < p_threshold;
    if not exists (select 1 from rs_match where old_id = r.old_id)
       and not exists (select 1 from rs_match where idx = r.idx) then
      insert into rs_match values (r.old_id, r.idx, r.score);
    end if;
  end loop;

  -- the plan, recorded whether or not it runs
  insert into reseed_matches(reseed_id, old_card_id, new_index, score, action, old_question, new_question)
    select log_id, m.old_id, m.idx, m.score, 'update', o.question, n.question
    from rs_match m join rs_old o on o.id = m.old_id join rs_new n on n.idx = m.idx;
  insert into reseed_matches(reseed_id, new_index, action, new_question)
    select log_id, n.idx, 'insert', n.question from rs_new n
    where not exists (select 1 from rs_match m where m.idx = n.idx);
  insert into reseed_matches(reseed_id, old_card_id, action, old_question)
    select log_id, o.id, 'archive', o.question from rs_old o
    where not exists (select 1 from rs_match m where m.old_id = o.id);
  select count(*) into n_upd from rs_match;
  n_ins := n_new - n_upd;
  n_arch := n_old - n_upd;
  select count(*) into arch_mastery from card_mastery where card_id in
    (select o.id from rs_old o where not exists (select 1 from rs_match m where m.old_id = o.id));
  select count(*) into arch_attempts from card_attempts where card_id in
    (select o.id from rs_old o where not exists (select 1 from rs_match m where m.old_id = o.id));

  if p_dry_run then
    update reseed_log set finished_at = now(),
      counts = jsonb_build_object('old', n_old, 'new', n_new, 'update', n_upd, 'insert', n_ins,
                                  'archive', n_arch, 'archive_mastery_rows', arch_mastery,
                                  'archive_attempt_rows', arch_attempts)
      where id = log_id;
    return (select jsonb_build_object(
      'reseed_id', log_id, 'dry_run', true,
      'counts', jsonb_build_object('old', n_old, 'new', n_new, 'update', n_upd, 'insert', n_ins,
                                   'archive', n_arch, 'archive_mastery_rows', arch_mastery,
                                   'archive_attempt_rows', arch_attempts),
      'plan', (select jsonb_agg(jsonb_build_object('action', action, 'old_card_id', old_card_id,
                 'new_index', new_index, 'score', round(score::numeric, 3),
                 'old', left(old_question, 80), 'new', left(new_question, 80)) order by action, old_card_id, new_index)
               from reseed_matches where reseed_id = log_id)));
  end if;

  -- ── THE SNAPSHOT. Nothing below runs unless all three tables were written. ──
  stamp := to_char(clock_timestamp(), 'YYYYMMDD_HH24MISS') || '_' || log_id;
  execute format('create table backup.%I as select * from flashcards where id in (select id from rs_old)', 'reseed_' || stamp || '_flashcards');
  execute format('create table backup.%I as select * from card_mastery where card_id in (select id from rs_old)', 'reseed_' || stamp || '_card_mastery');
  execute format('create table backup.%I as select * from card_attempts where card_id in (select id from rs_old)', 'reseed_' || stamp || '_card_attempts');
  snap := jsonb_build_object(
    'flashcards',    'backup.reseed_' || stamp || '_flashcards',
    'card_mastery',  'backup.reseed_' || stamp || '_card_mastery',
    'card_attempts', 'backup.reseed_' || stamp || '_card_attempts');
  update reseed_log set snapshot = snap where id = log_id;

  -- matched: update in place, id kept, history untouched
  update flashcards f set question = n.question, answer = n.answer,
         explanation = n.explanation, objective_ids = n.objective_ids
    from rs_match m join rs_new n on n.idx = m.idx where f.id = m.old_id;

  -- new: insert fresh
  insert into flashcards(question, answer, explanation, course, objective_ids, auto_generated, source_question_id)
    select n.question, n.answer, n.explanation, p_course, n.objective_ids, false, null
    from rs_new n where not exists (select 1 from rs_match m where m.idx = n.idx);

  -- removed: archive history, then the card, then delete (flag set for the guard)
  insert into archive.card_mastery
    select cm.*, log_id, now(), f.question, f.answer
    from card_mastery cm join flashcards f on f.id = cm.card_id
    where cm.card_id in (select o.id from rs_old o where not exists (select 1 from rs_match m where m.old_id = o.id));
  insert into archive.card_attempts
    select ca.*, log_id, now() from card_attempts ca
    where ca.card_id in (select o.id from rs_old o where not exists (select 1 from rs_match m where m.old_id = o.id));
  insert into archive.flashcards
    select f.*, log_id, now(), 'no match in reseed ' || log_id from flashcards f
    where f.id in (select o.id from rs_old o where not exists (select 1 from rs_match m where m.old_id = o.id));
  perform set_config('app.bulk_delete_ok', 'true', true);
  delete from card_mastery  where card_id in (select o.id from rs_old o where not exists (select 1 from rs_match m where m.old_id = o.id));
  delete from card_attempts where card_id in (select o.id from rs_old o where not exists (select 1 from rs_match m where m.old_id = o.id));
  delete from flashcards    where id      in (select o.id from rs_old o where not exists (select 1 from rs_match m where m.old_id = o.id));

  update reseed_log set finished_at = now(),
    counts = jsonb_build_object('old', n_old, 'new', n_new, 'update', n_upd, 'insert', n_ins,
                                'archive', n_arch, 'archive_mastery_rows', arch_mastery,
                                'archive_attempt_rows', arch_attempts)
    where id = log_id;
  return jsonb_build_object('reseed_id', log_id, 'dry_run', false, 'snapshot', snap,
    'counts', jsonb_build_object('old', n_old, 'new', n_new, 'update', n_upd, 'insert', n_ins,
                                 'archive', n_arch, 'archive_mastery_rows', arch_mastery,
                                 'archive_attempt_rows', arch_attempts));
end $$;

-- not callable from the app
revoke all on function public.reseed_flashcards(text, text, jsonb, boolean, real) from public, anon, authenticated;
revoke all on function public.bulk_delete_with_snapshot(text, text) from public, anon, authenticated;
revoke all on function public.guard_bulk_delete() from public, anon, authenticated;
