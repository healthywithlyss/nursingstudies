/* ══════════════════════════════════════════════════════════════════════════
   COURSES

   A course is registered in one list (COURSES) and a handful of maps keyed
   by course string. The failure this guards against is the one that put
   NUR144's questions into the NUR118 bank the day they were seeded: a course
   rule written as "everything that is NOT the other courses" absorbs any new
   course silently. So: every course in COURSES has a positive entry in every
   per-course map, no negative course filter exists anywhere in the page, and
   the quiz filter for a course with several prefixes ORs them (PostgREST ANDs
   a repeated column, which would match nothing).
   ══════════════════════════════════════════════════════════════════════════ */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const builder = fs.readFileSync(path.join(ROOT, 'scripts/build-guides-manifest.js'), 'utf8');

let fail = 0;
function ck(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); return; }
  fail++;
  console.log('  FAIL  ' + name + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)));
}
/* evaluate one `var NAME=...;` literal out of the page */
function literal(name) {
  const m = html.match(new RegExp('var ' + name + '\\s*=\\s*([\\s\\S]*?);\\n'));
  if (!m) return undefined;
  return new Function('return (' + m[1] + ');')();
}

const COURSES = literal('COURSES');
const TITLES = literal('COURSE_TITLES');
const PREFIXES = literal('QUIZ_COURSE_PREFIXES');
const SRS = literal('SRS_COURSES');
const GUIDES = literal('GUIDE_COURSES');
const GROUPS_SRC = (html.match(/var OBJ_GROUPS_BY_COURSE=\{([^}]*)\}/) || [])[1] || '';

console.log('\nthe course list and every per-course map agree');
ck('COURSES is a list of course strings', Array.isArray(COURSES) && COURSES.length >= 4, COURSES);
ck('NUR146 is registered', COURSES.includes('NUR146'));
for (const c of COURSES) {
  ck(`${c}: has a tab`, new RegExp('id="tab-' + c + '"').test(html));
  ck(`${c}: has a display title`, typeof TITLES[c] === 'string' && TITLES[c].length > 0, TITLES[c]);
  ck(`${c}: claims its quiz objective prefixes positively`, Array.isArray(PREFIXES[c]) && PREFIXES[c].length > 0, PREFIXES[c]);
  ck(`${c}: has an objective-group map`, new RegExp(c + ':').test(GROUPS_SRC), GROUPS_SRC);
  ck(`${c}: is known to the guide manifest builder`, new RegExp(c + ':\\s*\\{\\s*label:').test(builder));
}
ck('NUR146 is labelled "NUR 146 — Adult Health I"', /title="NUR 146 — Adult Health I"/.test(html) && TITLES.NUR146 === 'Adult Health I');
ck('SRS courses are a subset of COURSES', SRS.every((c) => COURSES.includes(c)), SRS);
ck('guide courses are a subset of COURSES', GUIDES.every((c) => COURSES.includes(c)), GUIDES);
ck('NUR146 behaves like NUR144: scheduled practice and markdown guides', SRS.includes('NUR146') && GUIDES.includes('NUR146'));

console.log('\nno prefix is claimed by two courses');
{
  const claims = {};
  for (const c of COURSES) for (const p of PREFIXES[c]) (claims[p] = claims[p] || []).push(c);
  const dupes = Object.entries(claims).filter(([, cs]) => cs.length > 1);
  ck('every prefix belongs to exactly one course', dupes.length === 0, dupes);
  /* a prefix that is a prefix of another course's prefix would match its ids too */
  const overlaps = [];
  for (const a of COURSES) for (const b of COURSES) if (a !== b)
    for (const pa of PREFIXES[a]) for (const pb of PREFIXES[b]) if (pb.startsWith(pa)) overlaps.push([a, pa, b, pb]);
  ck('no course prefix is a prefix of another course\'s prefix', overlaps.length === 0, overlaps);
}

console.log('\nno negative course filter anywhere in the page');
{
  const neg = [...html.matchAll(/objective_id=not\.|course=not\.|course=neq\.|objective_id=neq\.|not\.like\.|not\.in\.\(/g)].map((m) => m.index);
  ck('no not.like / not.in / neq filters on course or objective_id', neg.length === 0, neg.map((i) => html.slice(i - 60, i + 40)));
  const fn = html.slice(html.indexOf('function getQuizCourseFilter('), html.indexOf('var quizLoaded'));
  ck('getQuizCourseFilter reads the course\'s own prefixes only', /QUIZ_COURSE_PREFIXES\[currentCourse\]/.test(fn) && !/Object\.keys\(QUIZ_COURSE_PREFIXES\)/.test(fn));
  ck('an unregistered course matches NOTHING rather than another course\'s bank', /__no_course__/.test(fn));
  ck('several prefixes are ORed, not ANDed', /'or=\('\+mine\.map/.test(fn) && /objective_id\.like\./.test(fn));
  ck('a single prefix is a plain like filter', /if\(mine\.length===1\) return 'objective_id=like\.'\+mine\[0\]\+'%25';/.test(fn));
}

console.log('\nno course falls through to another course\'s data or sections');
{
  const groups = html.slice(html.indexOf('function getObjGroups('), html.indexOf('function getFCObjMap('));
  ck('getObjGroups is keyed by course with an empty default', /OBJ_GROUPS_BY_COURSE\[currentCourse\]\|\|\{\}/.test(groups) && !/NUR118_OBJ_GROUPS/.test(groups));
  ck('the practice sidebar uses GUIDE_COURSES, not a NUR144 literal', /if\(GUIDE_COURSES\.indexOf\(currentCourse\)>-1\) return \[\];/.test(html));
  ck('the tab loops iterate COURSES', (html.match(/COURSES\.forEach\(function\(c\)\{\s*var t=document\.getElementById\('tab-'\+c\);/g) || []).length === 2);
  ck('the guide pane shows for every guide course', /GUIDE_COURSES\.indexOf\(course\)>-1\?'':'none'/.test(html));
  ck('the guides module gates on GUIDE_COURSES', /GUIDE_COURSES\.indexOf\(window\.currentCourse\) > -1/.test(html));
  ck('no remaining === \'NUR144\' course checks outside the map literals', (html.match(/===\s*'NUR144'/g) || []).length === 0, (html.match(/===\s*'NUR144'/g) || []).length);
}

console.log(fail ? `\n${fail} FAILED` : '\nall course checks passed');
process.exit(fail ? 1 : 0);
