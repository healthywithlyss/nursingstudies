#!/usr/bin/env node
/**
 * NurseStudy — Bulk NCLEX Question Bank Generator — NUR116
 * Generates questions across all 13 NUR116 objectives.
 * Run: node scripts/generate-116-questions.js
 *
 * Reads .env from the parent directory (nursingstudies/.env).
 * Uses native fetch (Node 22+). No npm packages required.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

/* ── Load .env ─────────────────────────────────────────────────────────────── */
function loadEnv() {
  const paths = [
    resolve(__dir, '../.env'),
    resolve(__dir, '../.env.local'),
  ];
  for (const p of paths) {
    try {
      const lines = readFileSync(p, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
      }
      console.log(`Loaded env from ${p}`);
      break;
    } catch { /* try next */ }
  }
}
loadEnv();

const SUPABASE_URL   = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SERVICE_KEY || !GEMINI_API_KEY) {
  console.error('Missing env vars. Need EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY');
  process.exit(1);
}

const SB_HEADERS = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

/* ── Ordered objective list ─────────────────────────────────────────────────── */
const OBJECTIVES = [
  'N116T01','N116T02','N116T03','N116T04','N116T05','N116T06','N116T07',
  'N116T08','N116T09','N116T10','N116T11','N116T12','N116T13',
];

const OBJECTIVE_NAMES = {
  N116T01: 'EMTALA — Emergency Medical Treatment and Labor Act',
  N116T02: 'Good Samaritan Laws — scope, protections, and limits',
  N116T03: 'Urinalysis — normal values and interpretation',
  N116T04: 'Elimination — constipation, diarrhea, incontinence types, fecal impaction',
  N116T05: 'Urine specimen collection & catheterization (Foley, clean-catch, urine culture)',
  N116T06: 'Healthcare insurance — Medicare vs Medicaid',
  N116T07: 'Enteral & parenteral nutrition — NG tube, NJ tube, TPN, tube feeding',
  N116T08: 'Legal concepts — informed consent, advance directives, assault/battery, incident reports',
  N116T09: 'Safe medication administration — JCAHO abbreviations, leading/trailing zeros',
  N116T10: 'Safety — RACE fire response, fall prevention, alarm fatigue',
  N116T11: 'Nutrition & dysphagia — diet types, dysphagia interventions, spinal deformities',
  N116T12: 'Nursing ethics — 6 principles (autonomy, beneficence, nonmaleficence, justice, fidelity, veracity)',
  N116T13: 'Kübler-Ross stages of grief — 5 stages and patient behaviors',
};

/* ── Study guide text by objective ─────────────────────────────────────────── */
const STUDY_GUIDE = {

N116T01: `EMTALA — EMERGENCY MEDICAL TREATMENT AND LABOR ACT

PURPOSE: Enacted to prevent "patient dumping" — hospitals turning away uninsured or low-income patients.

KEY REQUIREMENTS:
1. Every ED patient must receive a Medical Screening Exam (MSE) regardless of insurance or ability to pay.
2. If the patient has an emergency medical condition, the hospital MUST stabilize the patient.
3. If the hospital CANNOT stabilize: a physician must sign that the benefits of transfer outweigh the risks BEFORE transfer.
4. If the hospital cannot provide the needed level of care: transfer the stabilized patient to a facility that can.
5. Insurance status does NOT affect EMTALA requirements — care is required regardless.

KEY DISTINCTION: EMTALA applies to the EMERGENCY DEPARTMENT specifically.`,

N116T02: `GOOD SAMARITAN LAWS

PURPOSE: Enacted to encourage healthcare professionals to render aid outside of work without fear of lawsuits.

WHAT IT PROTECTS AGAINST: Claims of negligence when providing care without expectation of payment.

3 THINGS THAT VOID GOOD SAMARITAN PROTECTION:
1. Receiving compensation for the care
2. Being negligent
3. Practicing outside your scope of practice

KEY FACTS:
- Nurses have NO legal obligation to help in an emergency OUTSIDE of employment
- Good Samaritan laws VARY by state — not uniform nationwide
- The nurse must provide care consistent with their training and scope`,

N116T03: `URINALYSIS — NORMAL VALUES

APPEARANCE:
- Color: pale yellow to amber
- Clarity: clear
- Odor: mild (aromatic)

CHEMICAL VALUES:
- pH: 5–9
- Protein: < 20 mg/dL (negative/trace)
- Glucose: negative
- Ketones: negative
- Hemoglobin: negative
- Leukocyte esterase: negative
- Nitrite: negative

MICROSCOPIC:
- WBC: 0–4/hpf
- RBC: ≤ 2/hpf
- Bacteria/yeast/parasites: none

PHYSICAL MEASURES:
- Specific gravity: 1.002–1.030
  - > 1.030 = concentrated (dehydration/hypovolemia)
  - < 1.002 = dilute (hypervolemia/overhydration)
- Minimum urine output adult: 30 mL/hour

ABNORMAL FINDINGS:
- Protein → kidney disease
- Glucose → diabetes mellitus
- WBCs → infection/UTI
- RBCs → bleeding/trauma
- Bacteria/nitrite → UTI`,

N116T04: `ELIMINATION — CONSTIPATION, DIARRHEA, INCONTINENCE & FECAL IMPACTION

CONSTIPATION:
- Definition: fewer than 3 bowel movements per week
- Stools: hard, lumpy, difficult to pass
- 6 symptoms requiring medical attention: fever, GI bleeding, abdominal pain, vomiting, low back pain, weight loss
- Risk factors: low fiber, low fluid, immobility, certain medications (opioids, iron)

DIARRHEA — 8 DIETARY RISK FACTORS:
Alcohol / Caffeine / Dairy / High-fat foods / Fructose beverages / Spicy foods / Apples-peaches-pears / Sweeteners (sorbitol, mannitol, xylitol, maltitol)

FECAL IMPACTION:
- Definition: hardened stool clumps together preventing evacuation — causes intestinal obstruction or rectal injury
- Most at risk: immobile clients or those with nervous system injury

TYPES OF URINARY INCONTINENCE:
1. Stress: urine leakage from increased pressure (coughing, sneezing, laughing, physical activity)
2. Urge: strong urge to urinate but leakage occurs before reaching the toilet — BLADDER TRAINING works well
3. Overflow: incomplete bladder emptying → bladder overfills and leaks
4. Reflex: urinary leakage caused by nerve damage — no warning sensation
5. Functional: physical inability to reach the toilet in time due to physical impairment

NOCTURNAL ENURESIS: nighttime bedwetting`,

N116T05: `URINE SPECIMEN COLLECTION & CATHETERIZATION

TYPES OF URINE SPECIMENS:
1. Routine Urinalysis (UA): standard collection for routine urine testing
2. Clean-Catch Midstream (Urine Culture): used to evaluate urine for bacteria/yeast causing UTI
   - Wipe 3 times front-to-back before collecting
   - Collect midstream (not beginning or end of stream)
   - Ask about antibiotics BEFORE collecting — antibiotics may alter the result and delay treatment
3. Sterile specimen: collected from an indwelling catheter or straight catheter

FOLEY CATHETER (indwelling):
3 Indications: (1) Surgical procedures, (2) Wounds where urine contacts and prevents healing, (3) Urinary retention
- Purpose: removes urine from the bladder continuously
- Bag MUST remain BELOW the level of the bladder at ALL times — NEVER on the floor
- Why: prevents backflow of urine which can cause infection

NG vs FOLEY:
- Foley = urinary catheter (bladder drainage)
- NG = nasogastric tube (stomach/feeding)`,

N116T06: `HEALTHCARE INSURANCE — MEDICARE vs MEDICAID

MEDICARE:
- Medical insurance for the ELDERLY (age 65+) and people with end-stage renal disease (ESRD)
- Federally funded program
- Mnemonic: Medicare = OLD (elderly), end-stage renal disease

MEDICAID:
- Medical insurance for the POOR / low-income individuals
- Jointly funded by state and federal government
- Mnemonic: Medicaid = POOR (low-income)

KEY DISTINCTION: MEDICARE = elderly/ESRD. MEDICAID = low-income/poor.`,

N116T07: `ENTERAL & PARENTERAL NUTRITION

NG TUBE (Nasogastric):
- Placement confirmation: X-RAY before FIRST USE — then verify by aspirating gastric contents and checking pH
- HOB position during tube feeding: 30–45 degrees (semi-Fowler's)
- HOB must stay elevated AFTER bolus feeding: at least 1 hour
- Overt aspiration symptoms: sudden cough, wheezing, trouble breathing, congestion, heartburn, throat clearing, chest discomfort

NJ TUBE (Nasojejunal):
- Placed by provider using guided radiology
- Placement verified by: X-ray prior to use

TPN (Total Parenteral Nutrition):
- Definition: intravenous nutrition administered into a LARGE VEIN via venous access device
- Purpose: prevents or corrects malnutrition
- Even NON-DIABETIC patients may need insulin while on TPN (high glucose in TPN formula)
- Key monitoring: blood glucose

KEY SAFETY: Never use NG tube without confirmed placement — aspiration risk.`,

N116T08: `LEGAL CONCEPTS — CONSENT, ADVANCE DIRECTIVES, ASSAULT/BATTERY & INCIDENT REPORTS

INFORMED CONSENT:
- Definition: permission to provide care given voluntarily by the client or legal representative without coercion
- Patient must be informed of: ALL risks and benefits before consenting
- Patient CAN withdraw consent at any time
- NURSE's role: VERIFY and WITNESS the signing — the nurse does NOT obtain consent (physician's responsibility)

ADVANCE DIRECTIVES:
- Living Will: states which life-sustaining treatments the patient WANTS if incapacitated
- Durable Power of Attorney for Healthcare: appoints someone to make healthcare decisions on patient's behalf
- Federal law: health care institutions MUST provide clients with forms to complete an advance directive
- A nurse CAN witness an advance directive WITHOUT an attorney

ASSAULT vs BATTERY:
- Assault: client is made to FEEL FEARFUL of harm or offensive contact (threat/fear — no contact)
- Battery: an act that CAUSES ACTUAL HARM or injury to a client — treated as a criminal offense

INCIDENT REPORTS:
- Purpose: to TRACK incidents and prevent them from happening again — risk management tool
- Is NOT part of the medical record
- Nurse should NEVER reference the incident report IN the chart
- After an incident: document assessment and interventions IN THE CLIENT'S MEDICAL RECORD (not in the incident report)`,

N116T09: `SAFE MEDICATION ADMINISTRATION — ABBREVIATIONS & ZEROS

JOINT COMMISSION (JCAHO) ABBREVIATION RULES:
- Maintains a list of POTENTIALLY DANGEROUS abbreviations to AVOID
- Each facility should establish its OWN approved list and educate staff
- Goal: prevent medication errors from misread abbreviations

LEADING ZEROS:
- ALWAYS USE: write 0.25 NOT .25
- Why: .25 could be misread as 25 (10× overdose)
- Rule: "Always use a leading zero before a decimal point"

TRAILING ZEROS:
- AVOID: write 25 NOT 25.0
- Why: 25.0 could be misread as 250 (10× overdose)
- Rule: "Never use a trailing zero after a decimal point for whole numbers"

MEMORY AID: "Lead with a zero, drop the trailing zero"
- 0.5 mg ✓ (not .5 mg)
- 5 mg ✓ (not 5.0 mg)`,

N116T10: `SAFETY — FIRE (RACE), FALL PREVENTION & ALARM FATIGUE

RACE FIRE RESPONSE (in order):
R — Rescue: remove clients, visitors, and employees in immediate danger
A — Alarm: activate the emergency fire alarm
C — Contain: close doors and windows to decrease oxygen supply to the fire
E — Extinguish: only if SAFE and proper extinguisher is available

FALL PREVENTION:
- Bed and chair alarms do NOT prevent falls — their purpose is to allow quick rescue if a patient gets up
- Risk factors for falls: altered mental status, medications (sedatives, diuretics), weakness, poor vision, unsafe environment

ALARM FATIGUE:
- Cause: frequent false/nuisance alarms → sensory overload
- Effect on staff: become desensitized — may not be aware of emergencies or have reduced reaction time
- Clinical significance: alarm fatigue is a patient safety hazard — staff may miss genuine emergency alarms`,

N116T11: `NUTRITION, DYSPHAGIA & SPINAL DEFORMITIES

DIET TYPES:
- NPO (Nothing by Mouth): used for swallowing difficulties or to protect from aspiration during surgery
- Clear Liquid: only clear liquids — broth, gelatin, water, foods that can be seen through or melt at room temperature; also used for N/V/D
- Full Liquid: fluids and foods liquid or liquid at room temperature — ice cream, juices, pudding, milkshakes, strained soups, protein shakes, gelatin
- Red-colored liquids/foods: AVOID for colon procedures and tonsillectomies — can be confused with bleeding

SPECIAL DIETS:
- Cardiovascular diet: controlling portions / more fruits and vegetables / whole grains / limiting unhealthy fats / low-fat protein / decreased sodium
- Renal diet restrictions: Sodium, Potassium, Phosphorus
  - High-potassium foods to AVOID: bananas, cantaloupe, tomatoes, oranges, prune juice, spinach, collard greens, kale, Swiss chard
- Post-surgery diet: increase PROTEIN to aid healing
- Vegan: need B12 supplementation (B12 only comes from animal sources)

DYSPHAGIA INTERVENTIONS (9):
1. Use assistive devices
2. Encourage self-feeding
3. HOB 90 degrees (fully upright) during feeding
4. Dentures in place if needed
5. Hearing aids in if needed
6. Remove clutter from environment
7. Toilet prior to feeding
8. NO straws — increase aspiration risk
9. Chin tuck while swallowing — reduces aspiration risk

SPINAL DEFORMITIES:
- Kyphosis: abnormal curvature of THORACIC (upper) spine (hunchback)
- Lordosis: abnormal curvature of LUMBAR (lower) spine (swayback)
- Scoliosis: LATERAL S-shaped curvature of the spine`,

N116T12: `NURSING ETHICS — 6 ETHICAL PRINCIPLES

1. AUTONOMY: the nurse's obligation to RESPECT the client's RIGHT to make their own healthcare decisions — INCLUDING the right to REFUSE care.

2. BENEFICENCE: the nurse's obligation to MINIMIZE HARM and ACT IN THE CLIENT'S BEST INTEREST — going ABOVE what is merely required.

3. NONMALEFICENCE: the nurse's obligation to DO NO HARM — or the LEAST amount of harm possible.
   KEY DISTINCTION: Beneficence = do GOOD. Nonmaleficence = do NO HARM.

4. JUSTICE: the nurse's obligation to provide IMPARTIAL, FAIR, EQUITABLE care regardless of age, sex, race, or economic status.

5. FIDELITY: the nurse's obligation to KEEP PROMISES and UPHOLD COMMITMENTS.

6. VERACITY: the nurse's obligation to provide TRUTHFUL and ACCURATE information.

MEMORY AID: A B N J F V
- Autonomy = choice/refusal
- Beneficence = act in best interest
- Nonmaleficence = do no harm
- Justice = fair/equitable
- Fidelity = keep promises
- Veracity = truth`,

N116T13: `KÜBLER-ROSS STAGES OF GRIEF

5 STAGES (in order): Denial → Anger → Bargaining → Depression → Acceptance

IMPORTANT: Stages are NOT sequential — patients can move back and forth between stages at any time.

STAGE DESCRIPTIONS & PATIENT BEHAVIORS:

1. DENIAL: Client refuses to believe reality to lessen the pain of the loss.
   - Behavior: "This isn't happening to me." / "There must be a mistake." / Refusing to accept a diagnosis.

2. ANGER: Anger releases emotional discomfort — blaming of others may occur.
   - Behavior: Blaming staff ("This isn't fair!") / Irritability toward family.

3. BARGAINING: Making a promise to a higher power in exchange for a better outcome — attempt to avoid grief through negotiating.
   - Behavior: "God, if you heal me I'll change my life." / Bargaining with a higher power.

4. DEPRESSION: Reality sets in — the loss is deeply felt.
   - Behavior: Withdrawing from others / Appearing deeply sad.
   - KEY: Depression in grief = withdrawing/sadness — do NOT confuse with anger.

5. ACCEPTANCE: The person still feels pain but realizes all will eventually be well.
   - Behavior: Peaceful acknowledgment / Making plans / Saying goodbyes.

NURSING IMPLICATIONS: Meet patients where they are in their grief. Do not rush patients through stages. Therapeutic communication; active listening; presence.`,

};

/* ── Supabase helpers ───────────────────────────────────────────────────────── */
async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { headers: SB_HEADERS });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
}

/* ── Get existing question counts per objective ─────────────────────────────── */
async function getExistingCounts() {
  const data = await sbGet('/quiz_questions?select=objective_id&is_targeted=eq.false&limit=10000');
  const counts = {};
  for (const r of data) {
    counts[r.objective_id] = (counts[r.objective_id] || 0) + 1;
  }
  return counts;
}

/* ── Fetch flashcards for an objective ──────────────────────────────────────── */
async function getFlashcards(objId) {
  const data = await sbGet(
    `/flashcards?select=question,answer&objective_ids=cs.%7B${objId}%7D&course=eq.NUR116&limit=200`
  );
  return data;
}

/* ── Call Gemini ─────────────────────────────────────────────────────────────── */
async function callGemini(objId, objName, cards, guideText) {
  const cardFacts = cards.map(c => `Q: ${c.question}\nA: ${c.answer}`).join('\n\n');

  const prompt = `You are a rigorous NCLEX-Next Generation exam writer for nursing students.

════════════════════════════════════
SOURCE MATERIAL — USE NOTHING ELSE
════════════════════════════════════
STUDY GUIDE (${objName}):
${guideText}

FLASHCARD FACTS FOR OBJECTIVE ${objId} (${objName}):
${cardFacts}

════════════════════════════════════
COVERAGE REQUIREMENT
════════════════════════════════════
You MUST cover EVERY distinct flashcard fact above at least 3 times across the question set.
Layered questions that integrate 2+ facts count toward each fact they test.
For comparison cards (A vs B), generate questions from both directions.
For list cards (e.g. 6 principles, 5 stages), test individual items AND the list as a whole.
For scenario cards, test nursing action and rationale separately.
For value cards (normal ranges), test what the abnormal value means clinically.
Do NOT skip any fact. Do NOT pad with generic or repeated questions.

════════════════════════════════════
DIFFICULTY — THIS IS THE MOST IMPORTANT RULE
════════════════════════════════════
EVERY question must:
1. Open with a realistic clinical PATIENT SCENARIO — a specific patient with a specific situation. Never a bare definition lookup.
2. Require APPLICATION of knowledge, not recall. The student must REASON to the correct answer.
3. INTEGRATE AT LEAST 2 FACTS from the source material — the student must combine knowledge to answer correctly. Examples of valid combinations: drug action + lab to monitor; disease pathophysiology + expected symptom; medication side effect + nursing intervention; abnormal lab value + ECG/assessment finding.
4. Use distractors that are PLAUSIBLE COMMON MISTAKES — what a real student WOULD choose: related-but-wrong value, correct-in-a-different-scenario, common misconception. NEVER obviously absurd or unrelated distractors.

FORBIDDEN STEM PATTERNS — do NOT write any question that:
• Starts with "What is the definition of ___?"
• Starts with "What does ___ stand for?"
• Starts with "Which of the following is ___?" or "What is ___?"
• Names a term and asks for its meaning without a patient context
• Can be answered correctly using only ONE flashcard fact

BAD STEM (never write like this — single fact, bare definition):
"What is the normal range for serum potassium?"

GOOD STEM (write like this — combines lab range + symptom recognition + drug fact):
"A client receiving daily furosemide reports muscle weakness and leg cramps. The nurse notes a flat T wave on the rhythm strip. Which laboratory value would the nurse expect to find?"

For select-all: include 3-5 correct answers and 2-3 convincing wrong ones, label clearly with "Select all that apply".
For priority: present a clinical scenario requiring the student to reason about urgency or sequence.
The correct answer must depend on source material knowledge — never answerable without studying.

Question types to use (vary them throughout):
- multiple_choice: 4 options, 1 correct — MOST COMMON
- select_all: 4-6 options, 2-4 correct
- priority: "Which action should the nurse take FIRST?" or "In what order should the nurse perform these actions?"

Respond with raw JSON only. No markdown, no explanation, no code fences.
{"questions":[{
  "type":"multiple_choice",
  "stem":"A nurse is caring for a client in the emergency department who...",
  "options":["A. text","B. text","C. text","D. text"],
  "correct":["B"],
  "explanation":"B is correct because [cite fact 1 from source] combined with [cite fact 2 from source]. A is wrong because... C is wrong because...",
  "fact_tested":"list the 2+ facts this question integrates (e.g. 'furosemide → K+ wasting; hypokalemia ECG = flat T')",
  "objective_id":"${objId}"
}]}`;

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 16384 },
    }),
  });

  const raw = await response.json();
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${JSON.stringify(raw)}`);

  const text = raw.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`No text in Gemini response: ${JSON.stringify(raw).slice(0,300)}`);

  // ── Robust JSON recovery ────────────────────────────────────────────────────
  const stripped = text
    .replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/```\s*$/m, '').trim();

  function sanitize(s) {
    let out = '';
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const prev = i > 0 ? s[i - 1] : '';
      if (c === '"' && prev !== '\\') {
        inStr = !inStr;
        out += c;
      } else if (inStr) {
        if      (c === '\n') out += '\\n';
        else if (c === '\r') out += '';
        else if (c === '\t') out += '\\t';
        else                 out += c;
      } else {
        out += c;
      }
    }
    return out;
  }

  function truncationRecover(s) {
    let depth = 0, inStr2 = false;
    const questionEnds = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const prev2 = i > 0 ? s[i - 1] : '';
      if (c === '"' && prev2 !== '\\') inStr2 = !inStr2;
      if (!inStr2) {
        if (c === '{') depth++;
        if (c === '}') {
          if (depth === 2) questionEnds.push(i);
          depth--;
        }
      }
    }
    if (!questionEnds.length) return null;
    const rebuilt = s.slice(0, questionEnds[questionEnds.length - 1] + 1) + ']}';
    try { return JSON.parse(rebuilt); } catch { return null; }
  }

  const clean = sanitize(stripped);
  let parsed = null;

  try { parsed = JSON.parse(clean); } catch { /* fall through */ }

  if (!parsed) {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch { /* fall through */ }
  }

  if (!parsed) parsed = truncationRecover(clean);
  if (!parsed) parsed = truncationRecover(stripped);

  if (!parsed) {
    const trimmed = clean.trimStart();
    if (trimmed.startsWith('[')) {
      try { parsed = { questions: JSON.parse(trimmed) }; } catch { /* fall through */ }
    }
  }

  if (!parsed) {
    const trimmed = clean.trimStart();
    if (trimmed.startsWith('"questions"')) {
      try { parsed = JSON.parse(`{${trimmed}}`); } catch { /* fall through */ }
      if (!parsed) parsed = truncationRecover(`{${trimmed}}`);
    }
  }

  if (!parsed) {
    throw new Error(`JSON parse failed after all recovery attempts.\nText was: ${stripped.slice(0, 500)}`);
  }

  return parsed.questions || [];
}

/* ── Save questions to Supabase ─────────────────────────────────────────────── */
async function saveQuestions(questions, fallbackObjId) {
  const rows = questions.map(q => ({
    objective_id: q.objective_id || fallbackObjId,
    type: q.type || 'multiple_choice',
    stem: q.stem,
    options: q.options,
    correct: Array.isArray(q.correct) ? q.correct : [q.correct],
    explanation: q.explanation || '',
    fact_tested: q.fact_tested || '',
    is_targeted: false,
  }));

  const BATCH = 20;
  for (let i = 0; i < rows.length; i += BATCH) {
    await sbPost('/quiz_questions', rows.slice(i, i + BATCH));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Main ────────────────────────────────────────────────────────────────────── */
async function main() {
  console.log('\n════════════════════════════════════════════════');
  console.log('  NurseStudy — NUR116 Question Bank Generator');
  console.log('════════════════════════════════════════════════\n');

  const existing = await getExistingCounts();
  const nur116Existing = OBJECTIVES.reduce((t, id) => t + (existing[id] || 0), 0);
  console.log(`Existing NUR116 questions in bank: ${nur116Existing}`);

  // Re-run any objective with fewer than 15 questions to get solid coverage
  const MIN_QUESTIONS = 15;
  const toGenerate = OBJECTIVES.filter(id => !(existing[id] >= MIN_QUESTIONS));
  const toSkip     = OBJECTIVES.filter(id =>  (existing[id] >= MIN_QUESTIONS));

  if (toSkip.length) {
    console.log(`\nSkipping ${toSkip.length} objectives (already have ≥${MIN_QUESTIONS} questions):`);
    toSkip.forEach(id => console.log(`  ✓ ${id} (${existing[id]} questions)`));
  }

  if (!toGenerate.length) {
    console.log('\nAll objectives already have questions!');
    await printFinalCount();
    return;
  }

  console.log(`\nGenerating for ${toGenerate.length} objectives...\n`);

  let totalNew = 0;
  const errors = [];

  for (let i = 0; i < toGenerate.length; i++) {
    const objId = toGenerate[i];
    const objName = OBJECTIVE_NAMES[objId] || objId;
    const guideText = STUDY_GUIDE[objId] || '';

    process.stdout.write(`[${i+1}/${toGenerate.length}] ${objId} — ${objName.slice(0,55)}... `);

    try {
      const allCards = await getFlashcards(objId);
      if (!allCards.length) {
        console.log(`SKIPPED (no flashcards found)`);
        continue;
      }

      // Cap at 20 cards per call to avoid token overflow
      const MAX_CARDS = 20;
      const cards = allCards.length > MAX_CARDS
        ? allCards.sort(() => Math.random() - 0.5).slice(0, MAX_CARDS)
        : allCards;

      const questions = await callGemini(objId, objName, cards, guideText);

      if (!questions.length) {
        console.log(`WARN: Gemini returned 0 questions`);
        errors.push({ objId, error: 'Gemini returned 0 questions' });
        continue;
      }

      await saveQuestions(questions, objId);
      totalNew += questions.length;
      console.log(`done (${questions.length} questions saved)`);

    } catch (err) {
      console.log(`ERROR: ${err.message.slice(0, 120)}`);
      errors.push({ objId, error: err.message });
    }

    if (i < toGenerate.length - 1) await sleep(5000);
  }

  console.log('\n════════════════════════════════════════════════');
  console.log(`  Generation complete! ${totalNew} new questions saved.`);
  if (errors.length) {
    console.log(`\n  ${errors.length} objective(s) failed:`);
    errors.forEach(e => console.log(`    ✗ ${e.objId}: ${e.error.slice(0, 80)}`));
    console.log('\n  Re-run the script to retry failed objectives.');
  }
  console.log('════════════════════════════════════════════════\n');

  await printFinalCount();
}

async function printFinalCount() {
  try {
    const data = await sbGet('/quiz_questions?select=objective_id&is_targeted=eq.false&limit=10000');
    const counts = {};
    for (const r of data) counts[r.objective_id] = (counts[r.objective_id] || 0) + 1;
    const nur116Total = OBJECTIVES.reduce((t, id) => t + (counts[id] || 0), 0);
    console.log(`\nNUR116 question bank: ${nur116Total} questions across ${OBJECTIVES.length} objectives`);
    console.log('\nBreakdown:');
    for (const id of OBJECTIVES) {
      const n = counts[id] || 0;
      const bar = '█'.repeat(Math.min(Math.floor(n / 3), 30));
      console.log(`  ${id.padEnd(10)} ${String(n).padStart(4)} ${bar}`);
    }
  } catch (e) {
    console.warn('Could not fetch final count:', e.message);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
