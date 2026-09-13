/* ══════════════════════════════════════════════════════════════════════════
   RESEED AND BULK-DELETE GUARD

   On 2026-09-12 a deck rebuild deleted 145 cards and every attempt any
   student had made on them. supabase/migrations/20260913_reseed_and_bulk_delete_guard.sql
   is the answer: a re-seed function that matches old cards to new ones and
   keeps their ids (so history carries over), archives what has no match, and
   refuses to run without its own snapshot; plus a statement-level trigger
   that refuses any delete of more than a handful of cards unless a
   sanctioned path has snapshotted first.

   CI has no Postgres, so this pins the migration's SOURCE: the ordering that
   makes it safe (snapshot before any write, archive before delete, the flag
   set only after the snapshot), the six guarded tables and their distinct
   columns, the dry-run default, and that the app cannot call any of it. The
   behaviour was proven once against the live database on a throwaway deck
   (dry run wrote nothing; the real run kept a matched card's id, mastery and
   attempts; the raw six-row delete was refused; the sanctioned one was not).
   A behavioural change that keeps these strings intact is possible, so read
   the migration when this file changes, not just the test.
   ══════════════════════════════════════════════════════════════════════════ */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILE = 'supabase/migrations/20260913_reseed_and_bulk_delete_guard.sql';
const SQL = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

let fail = 0;
function ck(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); return; }
  fail++;
  console.log('  FAIL  ' + name + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)));
}
/* body of one plpgsql function: from its create line to the closing `end $$;` */
function fnBody(name) {
  const start = SQL.indexOf('create or replace function public.' + name + '(');
  if (start < 0) return '';
  const end = SQL.indexOf('end $$;', start);
  return end < 0 ? '' : SQL.slice(start, end + 7);
}
const at = (hay, needle, from = 0) => hay.indexOf(needle, from);
/* every needle appears, and each strictly after the one before it */
function inOrder(hay, needles) {
  let p = -1;
  for (const n of needles) {
    const q = at(hay, n, p + 1);
    if (q < 0) return { ok: false, missing: n };
    p = q;
  }
  return { ok: true };
}
const count = (hay, re) => (hay.match(re) || []).length;

const EXPECTED_GUARD = {
  flashcards: 'id', quiz_questions: 'id',
  card_mastery: 'card_id', card_attempts: 'card_id',
  question_mastery: 'question_id', quiz_attempts: 'question_id'
};
const SIX = Object.keys(EXPECTED_GUARD);

/* ── 1. the guard ────────────────────────────────────────────────────── */
console.log('\nbulk-delete guard: six tables, statement level, distinct ids, threshold 5');
{
  const guard = fnBody('guard_bulk_delete');
  ck('guard_bulk_delete exists', guard.length > 0);
  ck('counts DISTINCT values of the configured column from the transition table',
    /count\(distinct %I\) from deleted/.test(guard));
  ck('refuses only above the limit and only when app.bulk_delete_ok is not true',
    /if n > lim and coalesce\(current_setting\('app\.bulk_delete_ok', true\), ''\) <> 'true' then/.test(guard));
  ck('refusal is an exception (check_violation), not a notice', /raise exception using[\s\S]*errcode = 'check_violation'/.test(guard));
  ck('refusal names both sanctioned paths in its hint',
    /hint = [\s\S]*bulk_delete_with_snapshot[\s\S]*reseed_flashcards/.test(guard));

  const doBlock = SQL.slice(SQL.indexOf('do $$'), SQL.indexOf('end $$;', SQL.indexOf('do $$')));
  const rows = {};
  for (const m of doBlock.matchAll(/\('(\w+)',\s*'(\w+)',\s*(\d+)\)/g)) rows[m[1]] = { col: m[2], lim: Number(m[3]) };
  ck('exactly the six content/history tables are guarded', JSON.stringify(Object.keys(rows).sort()) === JSON.stringify([...SIX].sort()), Object.keys(rows));
  for (const t of SIX) {
    ck(`${t}: counts distinct ${EXPECTED_GUARD[t]} (a single card rated by twelve students still passes)`,
      rows[t] && rows[t].col === EXPECTED_GUARD[t], rows[t]);
    ck(`${t}: threshold is 5`, rows[t] && rows[t].lim === 5, rows[t]);
  }
  ck('trigger is AFTER DELETE ... REFERENCING OLD TABLE ... FOR EACH STATEMENT',
    /create trigger %I after delete on public\.%I referencing old table as deleted\s+for each statement execute function public\.guard_bulk_delete\(%L, %L\)/.test(doBlock));
  ck('trigger is dropped-and-recreated so the migration is re-runnable', /drop trigger if exists %I on public\.%I/.test(doBlock));
}

/* ── 2. the flag ─────────────────────────────────────────────────────── */
console.log('\nthe bypass flag is transaction-local and set only by the two sanctioned paths, after their snapshot');
{
  const sets = [...SQL.matchAll(/set_config\('app\.bulk_delete_ok',\s*'true',\s*(\w+)\)/g)];
  ck('set exactly twice in the migration', sets.length === 2, sets.length);
  ck('every set is transaction-local (is_local = true), so it cannot leak past the statement that earned it',
    sets.every((m) => m[1] === 'true'), sets.map((m) => m[1]));
  ck('one set inside bulk_delete_with_snapshot', count(fnBody('bulk_delete_with_snapshot'), /set_config\('app\.bulk_delete_ok'/g) === 1);
  ck('one set inside reseed_flashcards', count(fnBody('reseed_flashcards'), /set_config\('app\.bulk_delete_ok'/g) === 1);

  /* nothing else in the repo sets it: not the app, not the edge functions, not the scripts */
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'vendor'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(html|js|mjs|ts|sql)$/.test(e.name)) continue;
      const rel = path.relative(ROOT, p);
      if (rel === FILE || rel === path.relative(ROOT, fileURLToPath(import.meta.url))) continue;
      if (fs.readFileSync(p, 'utf8').includes('bulk_delete_ok')) hits.push(rel);
    }
  };
  walk(ROOT);
  ck('no other file in the repo touches app.bulk_delete_ok', hits.length === 0, hits);
}

/* ── 3. the sanctioned ad-hoc delete ────────────────────────────────── */
console.log('\nbulk_delete_with_snapshot: allowlist, WHERE required, snapshot then log then flag then delete');
{
  const b = fnBody('bulk_delete_with_snapshot');
  ck('exists and is security definer', b.length > 0 && /security definer/.test(b));
  const allow = (b.match(/allowed text\[\] := array\[([^\]]+)\]/) || [])[1] || '';
  const list = allow.split(',').map((s) => s.trim().replace(/'/g, '')).sort();
  ck('allowlist is exactly the six guarded tables', JSON.stringify(list) === JSON.stringify([...SIX].sort()), list);
  ck('refuses a table outside the allowlist', /if not \(p_table = any\(allowed\)\) then\s+raise exception/.test(b));
  ck('refuses an empty WHERE (no whole-table deletes)', /if p_where is null or btrim\(p_where\) = '' then\s+raise exception/.test(b));
  const order = inOrder(b, [
    "raise exception 'bulk_delete_with_snapshot: a WHERE clause is required",
    'create table backup.%I as select * from public.%I where %s',
    'insert into reseed_log(kind, snapshot, counts, plan)',
    "set_config('app.bulk_delete_ok', 'true', true)",
    "execute format('delete from public.%I where %s'"
  ]);
  ck('order: WHERE check -> snapshot -> log -> flag -> delete', order.ok, order);
  ck('the snapshot table is named backup.<table>_bulk_<timestamp>', /format\('%s_bulk_%s', p_table, to_char\(clock_timestamp\(\)/.test(b));
  ck('reports the count it is about to remove (and that count comes from the snapshot, not the live table)',
    /select count\(\*\) from backup\.%I/.test(b) && /'deleted', n, 'snapshot'/.test(b));
  ck('a WHERE matching nothing keeps no snapshot and deletes nothing',
    at(b, "'deleted', 0, 'note'") > 0 && at(b, "'deleted', 0, 'note'") < at(b, "execute format('delete from"));
  ck('exactly one delete statement, and it is the flagged one', count(b, /delete from/g) === 1);
}

/* ── 4. the re-seed ──────────────────────────────────────────────────── */
console.log('\nreseed_flashcards: dry run by default and writes nothing; snapshot before any write; matched ids kept; archive before delete');
{
  const b = fnBody('reseed_flashcards');
  ck('exists and is security definer', b.length > 0 && /security definer/.test(b));
  ck('p_dry_run defaults to TRUE', /p_dry_run boolean default true/.test(b));
  ck('p_threshold defaults to 0.6', /p_threshold real default 0\.6/.test(b));
  ck('refuses an empty card list', /jsonb_array_length\(p_cards\) = 0 then\s+raise exception/.test(b));
  ck('refuses a card with an empty question or answer', /coalesce\(question,''\) = '' or coalesce\(answer,''\) = ''\) then\s+raise exception/.test(b));

  /* the dry-run branch: between `if p_dry_run then` and its return there is no write to any content or history table */
  const dryStart = at(b, 'if p_dry_run then');
  const dryEnd = at(b, 'end if;', dryStart);
  const dry = b.slice(dryStart, dryEnd);
  ck('dry-run branch exists and returns', dryStart > 0 && /return \(select jsonb_build_object\(/.test(dry));
  ck('dry-run branch touches only reseed_log',
    !/create table backup|update flashcards|insert into flashcards|insert into archive|delete from|set_config/.test(dry));
  ck('the plan (reseed_matches) is recorded before the dry-run branch, so a dry run leaves an inspectable plan',
    at(b, 'insert into reseed_matches') > 0 && at(b, 'insert into reseed_matches') < dryStart);

  /* the real run: three snapshot tables, all before the first write; flag before the deletes; archive before delete */
  const snaps = [
    "create table backup.%I as select * from flashcards where id in (select id from rs_old)', 'reseed_' || stamp || '_flashcards'",
    "create table backup.%I as select * from card_mastery where card_id in (select id from rs_old)', 'reseed_' || stamp || '_card_mastery'",
    "create table backup.%I as select * from card_attempts where card_id in (select id from rs_old)', 'reseed_' || stamp || '_card_attempts'"
  ];
  const firstWrite = Math.min(...['update flashcards', 'insert into flashcards', 'insert into archive.', 'delete from']
    .map((n) => at(b, n)).filter((i) => i > 0));
  ck('all three snapshots (flashcards, card_mastery, card_attempts) are written before the first write to any of them',
    snaps.every((s) => at(b, s) > dryEnd && at(b, s) < firstWrite), snaps.map((s) => at(b, s)).concat([firstWrite]));
  ck('snapshot names are recorded on the log row before any write', at(b, 'update reseed_log set snapshot = snap') < firstWrite);
  const order = inOrder(b, [
    'end if;',                                   /* after the dry-run branch */
    'create table backup.',
    'update flashcards f set question = n.question, answer = n.answer',
    'insert into flashcards(question, answer, explanation, course, objective_ids, auto_generated, source_question_id)',
    'insert into archive.card_mastery',
    'insert into archive.card_attempts',
    'insert into archive.flashcards',
    "set_config('app.bulk_delete_ok', 'true', true)",
    'delete from card_mastery',
    'delete from card_attempts',
    'delete from flashcards'
  ]);
  ck('order: snapshot -> update matched -> insert new -> archive mastery, attempts, card -> flag -> delete mastery, attempts, card', order.ok, order);

  /* matched cards keep their id: they are UPDATEd by old id, never deleted or re-inserted */
  ck('a matched card is updated in place by its old id (history rows keyed on card_id are untouched)',
    /update flashcards f set[\s\S]*?from rs_match m join rs_new n on n\.idx = m\.idx where f\.id = m\.old_id/.test(b));
  const unmatched = 'not exists (select 1 from rs_match m where m.old_id = o.id)';
  ck('every archive insert is scoped to UNMATCHED old cards', count(b, /insert into archive\.\w+[\s\S]*?not exists \(select 1 from rs_match m where m\.old_id = o\.id\)/g) === 3);
  const deletes = b.slice(at(b, "set_config('app.bulk_delete_ok'"));
  ck('every delete is scoped to UNMATCHED old cards',
    count(deletes, /delete from/g) === 3 && count(deletes, new RegExp(unmatched.replace(/[()]/g, '\\$&'), 'g')) === 3);
  ck('new cards are inserted only where no old card matched', /insert into flashcards[\s\S]*?where not exists \(select 1 from rs_match m where m\.idx = n\.idx\)/.test(b));
  ck('archived history rows carry the reseed id and the card text they belonged to',
    /insert into archive\.card_mastery\s+select cm\.\*, log_id, now\(\), f\.question, f\.answer/.test(b)
    && /insert into archive\.card_attempts\s+select ca\.\*, log_id, now\(\)/.test(b));

  /* matching rule */
  ck('scope is one course and one objective', /where f\.course = p_course and p_objective = any\(f\.objective_ids\)/.test(b));
  ck('score = 0.75 * question similarity + 0.25 * answer similarity', /\(0\.75 \* q_sim \+ 0\.25 \* a_sim\)::real score/.test(b));
  ck('an answer alone cannot claim a match (question similarity must reach 0.4)', /from rs_pairs where q_sim >= 0\.4/.test(b));
  ck('identical normalised text scores 1.0 regardless of trigram quirks', /case when o\.nq = n\.nq then 1\.0 else similarity\(o\.nq, n\.nq\) end/.test(b));
  ck('matching is one-to-one (old_id primary key, idx unique)', /rs_match \(old_id bigint primary key, idx int unique/.test(b));
  ck('matching stops at the threshold', /exit when r\.score < p_threshold/.test(b));
  ck('the plan is returned with scores and both question texts', /'score', round\(score::numeric, 3\)/.test(b) && /'old', left\(old_question, 80\), 'new', left\(new_question, 80\)/.test(b));
}

/* ── 5. not callable from the app ───────────────────────────────────── */
console.log('\nnothing here is reachable from the browser');
{
  ck('reseed_flashcards revoked from public, anon, authenticated',
    /revoke all on function public\.reseed_flashcards\(text, text, jsonb, boolean, real\) from public, anon, authenticated;/.test(SQL));
  ck('bulk_delete_with_snapshot revoked', /revoke all on function public\.bulk_delete_with_snapshot\(text, text\) from public, anon, authenticated;/.test(SQL));
  ck('guard_bulk_delete revoked', /revoke all on function public\.guard_bulk_delete\(\) from public, anon, authenticated;/.test(SQL));
  ck('reseed_log and reseed_matches have RLS on and no grants to app roles',
    /alter table public\.reseed_log enable row level security;/.test(SQL)
    && /alter table public\.reseed_matches enable row level security;/.test(SQL)
    && /revoke all on public\.reseed_log, public\.reseed_matches from anon, authenticated;/.test(SQL));
  ck('archive tables mirror the live ones and carry reseed_id + archived_at',
    ['flashcards', 'card_mastery', 'card_attempts'].every((t) =>
      new RegExp(`create table if not exists archive\\.${t} \\(\\s+like public\\.${t} including defaults,\\s+reseed_id\\s+bigint,\\s+archived_at timestamptz not null default now\\(\\)`).test(SQL)));
  ck('pg_trgm is installed in the extensions schema, and reseed_flashcards can see it',
    /create extension if not exists pg_trgm with schema extensions;/.test(SQL) && /set search_path = public, extensions/.test(fnBody('reseed_flashcards')));
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
