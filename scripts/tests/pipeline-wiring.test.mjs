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
function gem(prompt){
  if(prompt.includes('Return ONLY a JSON array of the atomic facts')||prompt.includes('atomic'))
    return JSON.stringify(['fact one','fact two']);
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
    return J({candidates:[{finishReason:'STOP',content:{parts:[{text:gem(p)}]}}]});
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
ck('summary carries unsourced count', /unsourced claims 0$/.test(c.summary), c.summary);
ck('dry run wrote nothing', !calls.some(u=>u.includes('podcast_episodes')), calls.filter(u=>u.includes('podcast')));
ck('markers stripped', !/CHECKPOINT/i.test(d.script));
console.log(fail?`\n${fail} FAILING`:'\nall wiring checks passed');
process.exit(fail?1:0);
