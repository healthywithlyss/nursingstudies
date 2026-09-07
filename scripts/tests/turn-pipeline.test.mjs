/* The spoken-turn handler with fetch faked (PostgREST, ListModels, Gemini).
 * Covers the paths that would otherwise only be discovered by talking to it:
 * the answer/question split, the three grading verdicts, silence, a question
 * the section cannot answer, and the mastery attribution the client fires
 * afterwards. It tests wiring and prompt contracts, not grading quality —
 * grading quality is a judgement only the real model can make.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let handler=null;
globalThis.Deno={ serve:(h)=>{handler=h;},
  env:{ get:(k)=>({SUPABASE_URL:'https://x.test',SUPABASE_ANON_KEY:'anon',GEMINI_API_KEY:'k'}[k]) } };

const EXPECTED=['Gastritis is disruption of the protective mucosal barrier',
                'Acute gastritis is self-limiting with recovery in 1-3 days'];
const CP=[{ordinal:0,question:'What is gastritis, and how long does the acute form take to settle?',
           expected_points:EXPECTED}];
const SECTION='## GASTRITIS\n\nDisruption of the **mucosal barrier**. Acute: **self-limiting**, recovery in **1-3 days**.\nHead of bed: 30 degrees in one place, 6-8 inches in another, 4-8 inches in a third.';

let gemScript=null, ttsCalls=[], reasonPrompts=[], transcribeParts=[], masteryWrites=[];
let QUESTIONS=[{id:11,fact_tested:'gastritis = disruption of the protective mucosal barrier'},
               {id:12,fact_tested:'acute gastritis - self-limiting, recovery 1-3 days'}];
let CARDS=[];
let MASTERY_EXISTING=[];

globalThis.fetch=async(url,init={})=>{
  url=String(url); const m=(init.method||'GET').toUpperCase();
  const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json'}});
  if(url.includes('/rest/v1/podcast_checkpoints')) return J(CP);
  if(url.includes('/rest/v1/quiz_questions')) return J(QUESTIONS);
  if(url.includes('/rest/v1/flashcards')) return J(CARDS);
  if(url.includes('/rest/v1/question_mastery')){
    if(m==='POST'){ masteryWrites.push({table:'question_mastery',rows:JSON.parse(init.body)}); return J([]); }
    return J(MASTERY_EXISTING);
  }
  if(url.includes('/rest/v1/card_mastery')){
    if(m==='POST'){ masteryWrites.push({table:'card_mastery',rows:JSON.parse(init.body)}); return J([]); }
    return J([]);
  }
  if(url.includes('models?key')) return J({models:[
    {name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']},
    {name:'models/gemini-3.8-flash-preview-tts',supportedGenerationMethods:['generateContent']}]});
  if(url.includes(':generateContent')){
    const b=JSON.parse(init.body); const parts=b.contents[0].parts;
    if(b.generationConfig&&b.generationConfig.responseModalities){
      ttsCalls.push({voice:b.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
                     text:parts[0].text});
      const pcm=Buffer.alloc(24000*2*2);   /* 2 seconds */
      return J({candidates:[{content:{parts:[{inlineData:{mimeType:'audio/L16;codec=pcm;rate=24000',
        data:pcm.toString('base64')}}]}}],usageMetadata:{totalTokenCount:400}});
    }
    if(parts.some(p=>p.inlineData)){
      transcribeParts.push(parts);
      return J({candidates:[{finishReason:'STOP',content:{parts:[{text:gemScript.transcript}]}}],
        usageMetadata:{totalTokenCount:200}});
    }
    reasonPrompts.push(parts[0].text);
    return J({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(gemScript.reason)}]}}],
      usageMetadata:{totalTokenCount:600}});
  }
  throw new Error('unexpected fetch '+url);
};

const src=readFileSync(new URL('../../supabase/functions/podcast-turn/index.ts',import.meta.url),'utf8')
  .replace(/^import "jsr:[^\n]*\n/,'// stripped\n');
const f=join(mkdtempSync(join(tmpdir(),'turn-')),'fn.ts'); writeFileSync(f,src);
await import(f);

const tok='x.'+Buffer.from(JSON.stringify({sub:'u-1'})).toString('base64')+'.y';
const call=(body,token=tok)=>{
  const headers={'content-type':'application/json'};
  if(token) headers.Authorization='Bearer '+token;
  return handler(new Request('https://x/',{method:'POST',headers,body:JSON.stringify(body)}))
    .then(async r=>({status:r.status,json:await r.json()}));
};
const AUDIO=Buffer.alloc(1000).toString('base64');
const turn=(over={})=>call(Object.assign({action:'turn',episode_id:'e1',checkpoint_ordinal:0,
  audio_b64:AUDIO,section_text:SECTION,voice:'Charon'},over));

let fail=0;
const ck=(n,ok,v)=>{ if(ok) console.log('  PASS  '+n); else {fail++;console.log('  FAIL  '+n+' -> '+JSON.stringify(v));} };

console.log('auth');
ck('no token is 401',(await call({action:'models'},null)).status===401);
ck('any signed-in user is allowed (not admin-gated)',(await call({action:'models'})).status===200);

console.log('\nmodel discovery');
const md=(await call({action:'models'})).json;
ck('tts model is a tts model',/tts/.test(md.tts),md.tts);
ck('reasoning model is not the tts model',md.reasoning!==md.tts&&!/tts/.test(md.reasoning),md.reasoning);
ck('says whether transcription is a dedicated model',typeof md.transcription_is_dedicated==='boolean');

console.log('\nvocabulary bias reaches the transcriber');
gemScript={transcript:'Gastritis is when the mucosal barrier breaks down.',
  reason:{kind:'answer',verdict:'partial',got:[EXPECTED[0]],missed:[EXPECTED[1]],
    missed_concepts:['acute gastritis resolves in 1-3 days'],in_source:true,
    reply:"You've got the barrier part. What you left out is how fast the acute form settles: one to three days."}};
let r=(await turn()).json;
const tp=transcribeParts[transcribeParts.length-1];
ck('audio is sent as inlineData',!!tp[0].inlineData);
ck('floor terms are in the prompt',/hematochezia/.test(tp[1].text)&&/Zenker/.test(tp[1].text));
ck('terms from the section are added too',/mucosal|Gastritis/i.test(tp[1].text));
ck('reports how many terms were biased',r.vocabulary_terms>20,r.vocabulary_terms);

console.log('\npartial answer — the common case');
ck('classified as an answer',r.kind==='answer');
ck('verdict partial',r.verdict==='partial');
ck('transcript returned for display',r.transcript.length>10,r.transcript);
ck('got and missed both reported',r.got.length===1&&r.missed.length===1);
ck('reply is spoken back',!!r.reply_audio_b64&&r.reply_seconds>0,{s:r.reply_seconds});
ck('spoken in the episode voice',ttsCalls[ttsCalls.length-1].voice==='Charon');
ck('the TTS text is the reply, not the JSON',ttsCalls[ttsCalls.length-1].text===r.reply);
ck('timings reported for each stage',r.timing_ms.transcribe>=0&&r.timing_ms.total>=0,r.timing_ms);

console.log('\nthe grading contract is actually in the prompt');
const rp=reasonPrompts[reasonPrompts.length-1];
ck('tells it to be generous on wording, strict on concepts',/GENEROUS ABOUT WORDING AND STRICT ABOUT CONCEPTS/.test(rp));
ck('carries the nose-to-ear example',/nose to ear to sternum/i.test(rp));
ck('forbids letting a vague answer pass',/NEVER let a vague answer through/.test(rp));
ck('names conflicting sources as a case',/CONFLICTS with itself/.test(rp));
ck('forbids outside knowledge',/only permitted source/i.test(rp)&&/Do NOT answer it from outside knowledge/.test(rp));
ck('the section text is supplied',rp.includes('mucosal barrier'));
ck('expected points are supplied',rp.includes(EXPECTED[1]));

console.log('\nright answer — brief, no over-praise instruction present');
gemScript={transcript:'Disruption of the mucosal barrier, and acute settles in one to three days.',
  reason:{kind:'answer',verdict:'right',got:EXPECTED,missed:[],missed_concepts:[],in_source:true,
    reply:'That is it. Keep going.'}};
r=(await turn()).json;
ck('verdict right',r.verdict==='right');
ck('nothing missed',r.missed_concepts.length===0);
ck('prompt tells it not to praise at length',/Do NOT praise at\s+length/.test(reasonPrompts[reasonPrompts.length-1]));

console.log('\nwrong answer');
gemScript={transcript:'Something about the stomach lining I think.',
  reason:{kind:'answer',verdict:'wrong',got:[],missed:EXPECTED,
    missed_concepts:['mucosal barrier definition','acute gastritis timeline'],in_source:true,
    reply:'Not quite. Gastritis is disruption of the mucosal barrier — the one thing stopping the stomach digesting itself.'}};
r=(await turn()).json;
ck('verdict wrong',r.verdict==='wrong');
ck('concepts flagged to revisit',r.missed_concepts.length===2,r.missed_concepts);

console.log('\nshe asked a question instead');
gemScript={transcript:'Wait, what is the difference between melena and hematochezia?',
  reason:{kind:'question',verdict:'na',got:[],missed:[],missed_concepts:[],in_source:true,
    reply:'Melena is black tarry stool from higher up; hematochezia is bright red from lower down. Back to where we were.'}};
r=(await turn()).json;
ck('classified as a question',r.kind==='question');
ck('verdict is not a grade',r.verdict==='na');
ck('still spoken back',!!r.reply_audio_b64);

console.log('\nasked something the section does not cover');
gemScript={transcript:'What is the dose of pantoprazole?',
  reason:{kind:'question',verdict:'na',got:[],missed:[],missed_concepts:[],in_source:false,
    reply:'That is not in your lecture materials — your guide never gives a dose for it.'}};
r=(await turn()).json;
ck('flagged as not in source',r.in_source===false);
ck('reply says so plainly',/not in your lecture materials/i.test(r.reply),r.reply);

console.log('\nsilence');
gemScript={transcript:'',reason:{}};
r=(await turn()).json;
ck('classified unclear, not graded wrong',r.kind==='unclear'&&r.verdict==='na');
ck('never called the reasoning model on silence',r.models.reasoning===null);
ck('still says something out loud',!!r.reply_audio_b64&&/didn't catch that/i.test(r.reply));

console.log('\nattribution — off the critical path');
masteryWrites=[];
gemScript={transcript:'x',reason:[{concept:'acute gastritis resolves in 1-3 days',question_ids:[12],card_ids:[]}]};
let a=(await call({action:'attribute',missed_concepts:['acute gastritis resolves in 1-3 days'],
  objective_prefix:'N144',course:'NUR144'})).json;
ck('wrote question mastery',a.question_ids.includes(12),a);
ck('used the existing table shape',(()=>{const w=masteryWrites.find(x=>x.table==='question_mastery');
  const r0=w&&w.rows[0];
  return r0&&r0.user_id==='u-1'&&r0.question_id===12&&r0.consecutive_correct===0
    &&r0.last_result===false&&r0.is_mastered===false&&typeof r0.total_attempts==='number';})(),
  masteryWrites[0]&&masteryWrites[0].rows[0]);
ck('a miss breaks the streak and counts an attempt',(()=>{const r0=masteryWrites[0].rows[0];
  return r0.consecutive_correct===0&&r0.total_attempts===1;})());
ck('says plainly that this course has no flashcards',/no flashcards/i.test(a.note||''),a.note);
ck('nothing missed means no write',(await call({action:'attribute',missed_concepts:[],
  objective_prefix:'N144',course:'NUR144'})).json.written===0);

console.log('\nincrementing an existing row rather than resetting it');
masteryWrites=[]; MASTERY_EXISTING=[{question_id:12,consecutive_correct:3,total_correct:5,total_attempts:9}];
gemScript={transcript:'x',reason:[{concept:'c',question_ids:[12],card_ids:[]}]};
await call({action:'attribute',missed_concepts:['c'],objective_prefix:'N144',course:'NUR144'});
ck('total_attempts incremented from the existing row',masteryWrites[0].rows[0].total_attempts===10,masteryWrites[0].rows[0]);
ck('total_correct preserved',masteryWrites[0].rows[0].total_correct===5);
ck('streak reset by the miss',masteryWrites[0].rows[0].consecutive_correct===0);

console.log('\nvalidation');
ck('section_text is required',/section_text is required/.test((await call({action:'turn',episode_id:'e1',
  checkpoint_ordinal:0,audio_b64:AUDIO})).json.error||''));
ck('audio is required',/audio_b64 is required/.test((await call({action:'turn',episode_id:'e1',
  checkpoint_ordinal:0,section_text:SECTION})).json.error||''));

console.log(fail?`\n${fail} FAILING`:'\nall turn pipeline checks passed');
process.exit(fail?1:0);
