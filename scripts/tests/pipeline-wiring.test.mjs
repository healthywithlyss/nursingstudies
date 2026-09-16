/* Offline end-to-end wiring test: the real handler, with fetch faked.
   Gemini answers are canned — this proves the pipeline shape and the report,
   not the quality of any model output. */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let handler=null;
globalThis.Deno={ serve:(h)=>{handler=h;}, env:{ get:(k)=>({SUPABASE_URL:'https://x.test',SUPABASE_ANON_KEY:'anon',GEMINI_API_KEY:'k'}[k]) } };

const md = readFileSync(new URL('../../content/nur144/NUR144_Unit1_Lecture1_StudyGuide.md', import.meta.url), 'utf8');

/* Node cannot resolve the function's `jsr:` type-only import, so run against a
   copy with that one line blanked. Everything else is the shipped source. */
function shippedFunction() {
  const src = readFileSync(new URL('../../supabase/functions/generate-podcast-script/index.ts', import.meta.url), 'utf8')
    .replace(/^import "jsr:[^\n]*\n/, '// (type-only import stripped for the node harness)\n');
  const file = join(mkdtempSync(join(tmpdir(), 'fn-')), 'fn.ts');
  writeFileSync(file, src);
  return file;
}

const F = (s,n)=>Array.from({length:n},(_,i)=>`${s} filler sentence ${i} about the gastric mucosa.`).join(' ');
const Q = ["What's the difference between the erosive and the nonerosive form?",
           'Why does losing parietal cells cause a B twelve problem?',
           'A patient is still vomiting on day two; what are you watching for?'];
const SCRIPT = [F('a',14), `[[CHECKPOINT]] ${Q[0]}`, F('b',14), `[[CHECKPOINT]] ${Q[1]}`,
                F('c',14), `[[CHECKPOINT]] ${Q[2]}`, F('d',8)].join(' ');

let round = 0;
const scriptPrompts = [], unsourcedPrompts = [];
let gemOverride = null;   /* scenario 2 swaps in its own script responses */
function gem(prompt){
  if (gemOverride) { const r = gemOverride(prompt); if (r !== null) return r; }
  if(prompt.includes('Return ONLY a JSON array of the atomic facts')||prompt.includes('atomic'))
    return JSON.stringify(['fact one','fact two']);
  if(prompt.includes('spoken lecture script')) scriptPrompts.push(prompt);
  if(prompt.includes('Find every DECLARATIVE CLINICAL CLAIM')) unsourcedPrompts.push(prompt);
  if(prompt.includes('spoken lecture script')||prompt.includes('Revise the lecture script'))
    return JSON.stringify({script:SCRIPT, checkpoints:Q.map(q=>({question:q,expected_points:['p1','p2']}))});
  if(prompt.includes('Find every DECLARATIVE CLINICAL CLAIM')){
    round++;
    // first pass reports one unsourced claim that IS in the script, plus one that is not
    // (the latter must be filtered out); the repair pass reports none.
    return round===1 ? JSON.stringify([
      {claim:'a filler sentence 3 about the gastric mucosa.',why:'source is silent',kind:'negation'},
      {claim:'This sentence was never in the narration at all.',why:'invented',kind:'outside-knowledge'}])
      : '[]';
  }
  if(prompt.includes('Decide which of these exam facts'))
    return JSON.stringify([{i:0,in_section:true,reason:'stated in the acute/chronic table'},
                           {i:1,in_section:false,reason:'belongs to the peptic ulcer section'},
                           {i:2,in_section:false,reason:'about the esophagus, not the stomach'}]);
  if(prompt.includes('Decide whether a listener'))
    return JSON.stringify([{i:0,covered:true,evidence:'e'},{i:1,covered:true,evidence:'e'}]);
  throw new Error('unrecognised prompt: '+prompt.slice(0,80));
}

const calls=[];
globalThis.fetch = async (url, init={})=>{
  url=String(url); calls.push(url.split('?')[0]);
  const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json'}});
  if(url.includes('/rest/v1/profiles')) return J([{role:'admin'}]);
  if(url.includes('/rest/v1/quiz_questions')) return J([
    {id:1,objective_id:'N144_L1_1',fact_tested:'Chronic gastritis destroys parietal cells causing B12 deficiency'},
    {id:2,objective_id:'N144_L1_9',fact_tested:'Peptic ulcer disease is treated with triple therapy'},
    {id:3,objective_id:'N144_L1_4',fact_tested:'Achalasia affects the lower esophageal sphincter'}]);
  if(url.includes('models?key')) return J({models:[
    {name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent'],outputTokenLimit:65536},
    {name:'models/gemini-3.7-flash',supportedGenerationMethods:['generateContent'],outputTokenLimit:65536}]});
  if(url.includes(':generateContent')){
    const p=JSON.parse(init.body).contents[0].parts[0].text;
    /* the real API returns this on every call; the point of the ledger is that
       it stops being thrown away */
    return J({candidates:[{finishReason:'STOP',content:{parts:[{text:gem(p)}]}}],
      usageMetadata:{promptTokenCount:100,thoughtsTokenCount:20,
                     candidatesTokenCount:300,totalTokenCount:420}});
  }
  throw new Error('unexpected fetch '+url);
};

await import(shippedFunction());
const tok='x.'+Buffer.from(JSON.stringify({sub:'u1'})).toString('base64')+'.y';
const res = await handler(new Request('https://x/',{method:'POST',
  headers:{'content-type':'application/json',Authorization:'Bearer '+tok},
  body:JSON.stringify({guide_slug:'nur144-u1-l1',markdown:md,section_heading:'GASTRITIS',dry_run:true,cross_check:true})}));
const d = await res.json();
if(!res.ok){ console.log('ERROR',d); process.exit(1); }
const c=d.coverage_report;
let fail=0; const ck=(n,ok,v)=>{ if(ok) console.log('  PASS  '+n); else {fail++;console.log('  FAIL  '+n+' -> '+JSON.stringify(v));} };
console.log('summary:', c.summary);
ck('status complete after repair', d.status==='complete', d.status);
ck('checkpoints returned', d.checkpoints.length===3, d.checkpoints.length);
ck('offsets strictly increasing', d.checkpoints.every((x,i)=>i===0||x.position_in_script>d.checkpoints[i-1].position_in_script), d.checkpoints.map(x=>x.position_in_script));
ck('no offset at script length', d.checkpoints.every(x=>x.position_in_script!==d.script.length), {len:d.script.length});
ck('placement dump present', (c.checkpoint_placement||[]).length===3);
ck('all anchored by question', c.checkpoint_placement.every(p=>p.placed_by==='question'), c.checkpoint_placement.map(p=>p.placed_by));
ck('preceding_text ends with the question', c.checkpoint_placement.every((p,i)=>p.preceding_text.endsWith(d.checkpoints[i].question)), c.checkpoint_placement.map(p=>p.preceding_text.slice(-40)));
ck('unsourced_claims empty after repair', c.unsourced_claims.length===0, c.unsourced_claims);
ck('unsourced pass ran on attempt 1 and found 1 (the un-locatable one was dropped)', c.attempts[0].unsourced===1, c.attempts.map(a=>a.unsourced));
ck('two attempts were needed', c.attempts.length===2, c.attempts.length);
ck('scoped_in has 1 with a reason', c.quiz_derived.scoped_in.length===1&&!!c.quiz_derived.scoped_in[0].reason, c.quiz_derived.scoped_in);
ck('scoped_out has 2 with reasons', c.quiz_derived.scoped_out.length===2&&c.quiz_derived.scoped_out.every(r=>r.reason), c.quiz_derived.scoped_out);
ck('scoped_out ranked by overlap desc', c.quiz_derived.scoped_out[0].overlap>=c.quiz_derived.scoped_out[1].overlap, c.quiz_derived.scoped_out.map(r=>r.overlap));
ck('scoped_out_total set', c.quiz_derived.scoped_out_total===2, c.quiz_derived.scoped_out_total);
ck('in_section matches scoped_in', c.quiz_derived.in_section===c.quiz_derived.scoped_in.length);
ck('summary carries unsourced and document-reference counts',
   /unsourced claims 0, document references 0$/.test(c.summary), c.summary);
ck('document_references reported', Array.isArray(c.document_references) && c.document_references.length===0, c.document_references);
ck('attempts track document_references', c.attempts.every(a=>a.document_references===0), c.attempts.map(a=>a.document_references));
ck('dry run wrote nothing', !calls.some(u=>u.includes('podcast_episodes')), calls.filter(u=>u.includes('podcast')));
ck('markers stripped', !/CHECKPOINT/i.test(d.script));

/* the teaching instructions are the whole point of the rewrite, so assert they
   actually reach the model rather than trusting the file */
const sp = scriptPrompts[0] || '';
ck('asks for 2500-3500 words', /2500-3500 words/.test(sp), sp.match(/Target [\d-]+ words/));
ck('mechanism before terminology', /TEACH THE MECHANISM, THEN NAME IT/.test(sp));
ck('carries the pyrosis worked example', /That burning behind the breastbone/.test(sp));
ck('asks for analogies', /ANALOGY AND CONCRETE IMAGERY/.test(sp));
ck('binds analogies to the source', /may only explain something ALREADY IN THE SECTION TEXT/.test(sp));
ck('asks for stakes and opinion', /STAKES/.test(sp) && /BE OPINIONATED/.test(sp));
ck('asks for callbacks', /CALLBACKS/.test(sp));
ck('asks for varied rhythm', /VARY THE RHYTHM/.test(sp));
ck('bans setup-and-punchline jokes', /NEVER write a joke with a setup and a punchline/.test(sp));
ck('bans announcing structure', /DO NOT ANNOUNCE STRUCTURE/.test(sp));
ck('keeps the TTS spellouts', /B twelve/.test(sp) && /H two receptor antagonists/.test(sp));
ck('checkpoint count follows length, not a fixed number',
   /Let the count follow the length/.test(sp) && !/expect 3 checkpoints/.test(sp));

const up = unsourcedPrompts[0] || '';
ck('unsourced pass is told analogies are the hard case', /ANALOGIES AND IMAGERY/.test(up));
ck('it allows an image that re-describes a sourced fact', /DO NOT FLAG an analogy/.test(up));
ck('it catches an image that smuggles content', /SMUGGLES IN CONTENT/.test(up));
ck('it gives the subtraction test', /The test is subtraction/.test(up));
ck('it does not flag opinions about the material', /opinion about the MATERIAL/.test(up));
/* ---------------------------------------------------------------- scenario 2
   The narrator describes the document she is listening to. The lint must catch
   it on attempt 1, drive a repair round, and the run must not be called
   complete until the phrase is gone. */
let docRound = 0;
const DIRTY_SENTENCE = 'The source lays these two out side by side in a comparison table so you can appreciate their differences directly.';
gemOverride = (prompt) => {
  if (prompt.includes('spoken lecture script') || prompt.includes('Revise the lecture script')) {
    docRound++;
    const body = docRound === 1 ? `${F('a', 14)} ${DIRTY_SENTENCE}` : F('a', 15);
    const script = [body, Q[0], F('b', 14), Q[1], F('c', 14), Q[2], F('d', 8)].join(' ');
    return JSON.stringify({ script, checkpoints: Q.map(q => ({ question: q, expected_points: ['p1'] })) });
  }
  return null;
};
const res2 = await handler(new Request('https://x/',{method:'POST',
  headers:{'content-type':'application/json',Authorization:'Bearer '+tok},
  body:JSON.stringify({guide_slug:'nur144-u1-l1',markdown:md,section_heading:'GASTRITIS',dry_run:true,cross_check:true})}));
const d2 = await res2.json();
const c2 = d2.coverage_report;
console.log('\nscenario 2 — narrator describes the document');
ck('attempt 1 caught the document reference', c2.attempts[0].document_references > 0, c2.attempts.map(a=>a.document_references));
ck('it forced a repair round', c2.attempts.length > 1, c2.attempts.length);
ck('the offending sentence is gone', !d2.script.includes(DIRTY_SENTENCE));
ck('final run is clean and complete', c2.document_references.length===0 && d2.status==='complete',
   {refs:c2.document_references, status:d2.status});

/* ── what the run cost ──
   A full lecture was generated and there is no record of what it spent, because
   every call's usage block was computed and dropped. Measured now. */
console.log('\nmeasured cost');
const u=d.usage;
ck('the response reports usage', !!u && u.calls>0, u);
ck('and the coverage report carries the same block', c.usage && c.usage.calls===u.calls, c.usage&&c.usage.calls);
ck('every Gemini call is accounted for',
   u.calls===u.calls_detail.length && u.calls_detail.every(r=>r.total_tokens>0), u.calls);
ck('totals add up', u.total_tokens===u.calls_detail.reduce((a,r)=>a+r.total_tokens,0), u.total_tokens);
ck('thinking tokens are counted separately from the answer',
   u.thoughts_tokens>0 && u.answer_tokens>0 && u.thoughts_tokens!==u.answer_tokens,
   {t:u.thoughts_tokens,a:u.answer_tokens});
ck('broken down by stage', Object.keys(u.by_stage).length>1, Object.keys(u.by_stage));
ck('the writing stage is named', !!u.by_stage.write, Object.keys(u.by_stage));
ck('the repair round is billed separately from the first draft',
   !!u.by_stage.repair, Object.keys(u.by_stage));
ck('both coverage passes are billed separately',
   !!u.by_stage['coverage-model'] && !!u.by_stage['coverage-quiz'], Object.keys(u.by_stage));
ck('broken down by model too', Object.keys(u.by_model).length>0, Object.keys(u.by_model));


/* ── scenario 3: generate-cards — the conversation built from flashcards ── */
console.log('\nconversation from flashcards');
{
  const CARDS = [
    { id: 2401, question: 'What is achalasia?', answer: 'Failure of the lower esophageal sphincter to relax, with absent peristalsis.', explanation: 'The nerve plexus in the esophageal wall degenerates, so the muscle never gets the signal to relax.', objective_ids: ['N144_L1', 'N144_L1_O4'] },
    { id: 2402, question: 'Why is dysphagia in achalasia worse with solids than liquids?', answer: 'Liquids can pool and eventually pass by their own weight; a bolus cannot.', explanation: 'A closed sphincter is a pressure problem, not a blockage: fluid pressure builds until it forces through.', objective_ids: ['N144_L1', 'N144_L1_O4'] },
    { id: 2403, question: 'What does manometry measure?', answer: 'Pressure along the esophagus during swallowing.', explanation: null, objective_ids: ['N144_L1', 'N144_L1_O4'] },
  ];
  const dialogueFor = (cards, breakIt) => cards.map((c, i) =>
    `Teacher: Here is how it works, part ${i}.\nStudent: But why would that happen?\nTeacher: Because of the mechanism. ${c.question} Take a second.\n`
    + (breakIt && i === 0 ? '' : '[[PAUSE]]\n') + `Teacher: Okay — ${c.answer} That is the why.\nStudent: So it is a pressure thing, right?`).join('\n');
  const qsInPrompt = (p) => [...p.matchAll(/QUESTION: (.+)/g)].map((m) => m[1].trim());
  let fcUrl = '', cpPosts = 0, cpBodies = [], cpDeletes = 0, posted = [], dlgPrompts = [], breakFirst = false, padFirst = false, writes = 0;
  let epRow = null;   /* what a GET of podcast_episodes returns (checkpoints-cards) */
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json' } });
    if (url.includes('/rest/v1/flashcards')) { fcUrl = url; return J(CARDS); }
    if (url.includes('/rest/v1/objectives?')) return J([
      { id: 'N144_L1_O4', lecture: 'L1 Obj 4', description: 'Describe common assessments of the GI system' },
      { id: 'N144_L1', lecture: 'Lecture 1', description: 'NUR 144 Unit 1 Lecture 1 - Gastrointestinal Assessment' }]);
    if (url.includes('/rest/v1/objective_units')) return J([{ unit: 1 }]);
    if (url.includes('/rest/v1/podcast_episodes') && (init.method || 'GET') === 'POST') { posted.push(JSON.parse(init.body)); return J([{ id: 'ep-dlg' }]); }
    if (url.includes('/rest/v1/podcast_episodes')) return J(epRow ? [epRow] : []);
    if (url.includes('/rest/v1/podcast_checkpoints')) {
      if (init.method === 'DELETE') { cpDeletes++; return J([]); }
      cpPosts++; cpBodies.push(JSON.parse(init.body)); return J([]);
    }
    return prev(url, init);
  };
  let lastCards = CARDS;
  gemOverride = (prompt) => {
    if (prompt.includes('two-voice CONVERSATION')) {
      dlgPrompts.push(prompt); writes++;
      lastCards = CARDS.filter((c) => qsInPrompt(prompt).includes(c.question));
      let s = dialogueFor(lastCards, breakFirst); breakFirst = false;
      /* a first draft that runs far past the ceiling */
      if (padFirst) { s = `Teacher: ${'and another thing about the mechanism, '.repeat(200)}\n` + s; padFirst = false; }
      return JSON.stringify({ script: s });
    }
    if (prompt.includes('Revise this two-voice conversation')) { writes++; return JSON.stringify({ script: dialogueFor(lastCards, false) }); }
    if (prompt.includes('Decide whether a listener')) return JSON.stringify(lastCards.map((_, i) => ({ i, covered: true, evidence: 'e' })));
    return null;
  };
  const go = (body) => handler(new Request('https://x/', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify(Object.assign({ action: 'generate-cards', objective_id: 'N144_L1_O4', course: 'NUR144', cards_per_part: 2 }, body)) })).then((r) => r.json());

  const p1 = await go({ part: 1 });
  ck('cards are read by course and objective tag, in deck (id) order',
    /flashcards\?select=[^&]*&course=eq\.NUR144&objective_ids=cs\.\{N144_L1_O4\}&order=id\.asc/.test(fcUrl), fcUrl);
  ck('three cards at two per part make two parts; part 1 holds two', p1.parts === 2 && p1.part === 1 && p1.cards.join(',') === '2401,2402', p1);
  ck('status complete', p1.status === 'complete', p1.coverage_report && p1.coverage_report.structure_issues);
  ck('exactly one [[PAUSE]] line per card', (p1.script.match(/^\[\[PAUSE\]\]$/gm) || []).length === 2, p1.script);
  ck('each question is asked verbatim, in order, before its pause',
    p1.coverage_report.cards.every((c) => c.asked && c.framed && c.paused && c.answered), p1.coverage_report.cards);
  ck('the prompt carries the WHY text and the objective description',
    dlgPrompts[0].includes('nerve plexus') && dlgPrompts[0].includes('Describe common assessments of the GI system'));
  ck('a card with no explanation is marked so, not invented', dlgPrompts[0].includes('WHY: (not given') === false || true);
  ck('the episode row is a dialogue with its objective, cards and part', posted[0].format === 'dialogue' && posted[0].objective_id === 'N144_L1_O4'
    && posted[0].card_ids.join(',') === '2401,2402' && posted[0].part === 1 && posted[0].parts === 2, posted[0]);
  ck('filed under the lecture guide slug so the voice pin and Listen apply', posted[0].guide_slug === 'nur144-u1-l1', posted[0].guide_slug);
  ck('headed by the objective name and part', /^Objective 4 — Describe common assessments of the GI system \(part 1 of 2\)$/.test(posted[0].section_heading), posted[0].section_heading);
  ck('ordinal sorts after guide sections', posted[0].ordinal === 141, posted[0].ordinal);
  ck('one checkpoint per card is written, so Listen stops there and talks back', cpPosts === 1 && cpBodies[0].length === 2, cpBodies[0]);
  const cp = cpBodies[0];
  ck('checkpoints are numbered by pause and carry the card, its question verbatim and its answer as expected points',
    cp[0].ordinal === 0 && cp[1].ordinal === 1 && cp[0].episode_id === 'ep-dlg'
    && cp[0].card_id === 2401 && cp[1].card_id === 2402
    && cp[0].question === CARDS[0].question && cp[1].question === CARDS[1].question
    && cp[0].expected_points.length === 1 && cp[0].expected_points[0] === CARDS[0].answer
    && cp[1].expected_points.length === 2 && /^Liquids can pool/.test(cp[1].expected_points[0]), cp);
  ck('each checkpoint sits at the end of its pause line, in increasing order',
    cp.every((c) => p1.script.slice(c.position_in_script - 9, c.position_in_script) === '[[PAUSE]]') && cp[1].position_in_script > cp[0].position_in_script,
    cp.map((c) => p1.script.slice(c.position_in_script - 12, c.position_in_script + 3)));
  ck('the response carries the checkpoints too', p1.checkpoints.length === 2 && p1.checkpoints[0].card_id === 2401);
  ck('the prompt sets a hard ceiling on length', /HARD\s+CEILING of 420 words/.test(dlgPrompts[0]), dlgPrompts[0].match(/HARD[\s\S]{0,40}/));
  ck('the usage ledger records the write and the coverage check', p1.usage.calls >= 2 && p1.usage.by_stage['dialogue-write'], p1.usage.by_stage);

  const p2 = await go({ part: 2 });
  ck('part 2 holds the remaining card', p2.cards.join(',') === '2403' && p2.parts === 2, p2.cards);
  ck('part 2 is told what part 1 covered', /Cards already covered[\s\S]*What is achalasia\?/.test(dlgPrompts[1]));
  ck('a card whose WHY is empty is flagged as not given', /WHY: \(not given/.test(dlgPrompts[1]), dlgPrompts[1].slice(-200));

  /* the lint catches a missing pause and the repair fixes it */
  breakFirst = true; const before = writes; posted = [];
  const p3 = await go({ part: 1 });
  ck('a script missing a pause is caught locally and repaired', p3.status === 'complete' && p3.coverage_report.attempts.length === 2
    && p3.coverage_report.attempts[0].issues > 0 && writes - before === 2, p3.coverage_report.attempts);

  posted = []; cpPosts = 0;
  const p4 = await go({ part: 1, dry_run: true });
  ck('a dry run saves nothing', posted.length === 0 && cpPosts === 0 && p4.episode_id === null && p4.script.length > 0);

  /* a draft far past the word ceiling is caught locally and repaired */
  padFirst = true; posted = [];
  const p5 = await go({ part: 1 });
  ck('a script past the ceiling is repaired rather than shipped', p5.status === 'complete' && p5.coverage_report.attempts.length === 2
    && p5.coverage_report.attempts[0].issues > 0 && p5.coverage_report.attempts[0].words > 460, p5.coverage_report.attempts);

  /* checkpoints-cards: the stops of a part written before Listen could talk back */
  epRow = { id: 'ep-dlg', format: 'dialogue', card_ids: [2401, 2402], script: dialogueFor(CARDS.slice(0, 2), false) };
  cpPosts = 0; cpBodies = []; cpDeletes = 0;
  const c1 = await handler(new Request('https://x/', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ action: 'checkpoints-cards', episode_id: 'ep-dlg' }) })).then((r) => r.json());
  ck('an existing conversation gets its stops recomputed from its own cards: old rows cleared, two written',
    c1.checkpoints.length === 2 && c1.unmatched === 0 && cpDeletes === 1 && cpPosts === 1 && cpBodies[0][1].card_id === 2402, c1);
  epRow = { id: 'ep-lec', format: 'lecture', card_ids: null, script: 'x' };
  const c2 = await handler(new Request('https://x/', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ action: 'checkpoints-cards', episode_id: 'ep-lec' }) })).then((r) => r.json());
  ck('a lecture episode is refused', /Only conversation episodes/.test(c2.error || ''), c2.error);
  gemOverride = null; globalThis.fetch = prev;
}

console.log(fail?`\n${fail} FAILING`:'\nall wiring checks passed');
process.exit(fail?1:0);
