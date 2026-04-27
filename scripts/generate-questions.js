#!/usr/bin/env node
/**
 * NurseStudy — Bulk NCLEX Question Bank Generator
 * Generates ~1000+ questions across all 49 NUR118 objectives.
 * Run: node scripts/generate-questions.js
 *
 * Reads .env from the parent directory (nursingstudies/.env or .env.local).
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
  'L78_01','L78_02','L78_03','L78_04','L78_05','L78_06','L78_07','L78_08',
  'L78_09','L78_10','L78_11','L78_12','L78_13','L78_14','L78_15','L78_16',
  'L910_01','L910_02','L910_04','L910_05','L910_06','L910_07',
  'L11A_01','L11A_02','L11A_03','L11A_04',
  'L11F_01','L11F_02','L11F_03','L11F_04','L11F_05','L11F_06','L11F_07','L11F_08',
  'L12I_01','L12I_02','L12I_03','L12I_04','L12I_05',
  'L12M_01','L12M_02',
  'MED_01','MED_02','MED_03','MED_04','MED_05',
  'LAB_01','LAB_02',
];

const OBJECTIVE_NAMES = {
  L78_01:'Upper vs lower airway anatomy & gas exchange',
  L78_02:'Ventilation vs respiration vs oxygenation',
  L78_03:'Respiratory inspection — 6 characteristics & sputum assessment',
  L78_04:'9 breathing patterns (eupnea through stridor)',
  L78_05:'8 signs of respiratory distress',
  L78_06:'Respiratory palpation & percussion',
  L78_07:'Lung auscultation — normal sounds & adventitious sounds',
  L78_08:'Hypoxemia vs hypoxia — early & late signs',
  L78_09:'COPD — chronic bronchitis vs emphysema',
  L78_10:'Obstructive sleep apnea — S&S, risk factors, treatment',
  L78_11:'Hypoxic drive — normal vs COPD O2 stimulus',
  L78_12:'Supplemental O2 devices — NC, masks, Venturi',
  L78_13:'Suctioning — Yankauer vs suction catheter technique',
  L78_14:'Respiratory nursing interventions — positioning, IS, PLB, peak flow',
  L78_15:'Respiratory medications — codeine vs guaifenesin',
  L78_16:'Respiratory labs & diagnostics — SpO2, ABGs, PPD, PFTs, CXR',
  L910_01:'Cardiovascular anatomy — conduction, ANS, blood flow, EKG waves',
  L910_02:'Cardiovascular assessment — inspection, palpation, auscultation',
  L910_04:'Heart failure — left vs right HF etiology, S&S',
  L910_05:'Peripheral vascular disease — 5 P\'s+T, PAD vs PVD',
  L910_06:'Cardiovascular nursing interventions & patient teaching',
  L910_07:'Cardiovascular medications — atenolol, enalapril, nitroglycerin, digoxin, atorvastatin',
  L11A_01:'Acid-base — 3 mechanisms that maintain balance (buffers, lungs, kidneys)',
  L11A_02:'Normal ABG values & interpretation method (ROME, tic-tac-toe)',
  L11A_03:'Respiratory acidosis & respiratory alkalosis — causes, S&S, treatment',
  L11A_04:'Metabolic acidosis & metabolic alkalosis — causes, S&S, treatment',
  L11F_01:'Fluid compartments — ICF vs ECF subtypes, third spacing',
  L11F_02:'Fluid movement mechanisms — osmosis, diffusion, filtration, active transport',
  L11F_03:'10 signs of hypovolemia (need for fluids)',
  L11F_04:'ADH role in fluid balance — SIADH vs diabetes insipidus',
  L11F_05:'Hypovolemia vs hypervolemia — S&S & lab values',
  L11F_06:'Nursing interventions — increasing vs restricting fluids',
  L11F_07:'IV fluid tonicity — isotonic, hypotonic, hypertonic fluids',
  L11F_08:'Electrolyte imbalances — Na+, K+, Ca2+, Mg2+ (normal values, causes, S&S, TX)',
  L12I_01:'Peripheral IV therapy — gauge, complications (5 types) & interventions',
  L12I_02:'Central vascular access — CVC, PICC, implanted port',
  L12I_03:'Blood product indications — PRBCs, platelets, plasma',
  L12I_04:'Blood transfusion — time rules, setup, 2-nurse check',
  L12I_05:'Transfusion reactions — 5 types, S&S, nursing interventions',
  L12M_01:'Causes of escalating healthcare costs',
  L12M_02:'Nurse\'s role in cost containment & ANA resource stewardship standard',
  MED_01:'Cardiovascular medications — atenolol, enalapril, nitroglycerin, digoxin, atorvastatin',
  MED_02:'Anticoagulants — heparin, enoxaparin, warfarin (monitoring, antidotes, bleeding precautions)',
  MED_03:'Diuretics & electrolyte supplements — furosemide, spironolactone, KCl, calcium carbonate',
  MED_04:'Respiratory medications — prednisone, albuterol/ipratropium, codeine, guaifenesin',
  MED_05:'Endocrine & GI medications — Humulin R, Humulin N, loperamide',
  LAB_01:'Lab values — normal ranges for CBC, CMP, coagulation, cardiac markers, urinalysis',
  LAB_02:'Lab value interpretation — what high/low values indicate clinically',
};

/* ── Study guide text by section ────────────────────────────────────────────── */
/* Plain-text distillation of the HTML study guide sections.
   Each objective key maps to a section key, which maps to this text. */
const SECTION_FOR_OBJ = {
  L78_01:'resp', L78_02:'resp', L78_03:'resp', L78_04:'resp', L78_05:'resp',
  L78_06:'resp', L78_07:'resp', L78_08:'resp', L78_09:'resp', L78_10:'resp',
  L78_11:'resp', L78_12:'resp', L78_13:'resp', L78_14:'resp', L78_15:'resp',
  L78_16:'resp',
  L910_01:'cardio', L910_02:'cardio', L910_04:'cardio', L910_05:'cardio',
  L910_06:'cardio', L910_07:'cardio',
  L11A_01:'abg', L11A_02:'abg', L11A_03:'abg', L11A_04:'abg',
  L11F_01:'fluids', L11F_02:'fluids', L11F_03:'fluids', L11F_04:'fluids',
  L11F_05:'fluids', L11F_06:'fluids', L11F_07:'fluids', L11F_08:'elytes',
  L12I_01:'iv', L12I_02:'iv', L12I_03:'iv', L12I_04:'iv', L12I_05:'iv',
  L12M_01:'mgmt', L12M_02:'mgmt',
  MED_01:'meds', MED_02:'meds', MED_03:'meds', MED_04:'meds', MED_05:'meds',
  LAB_01:'labs', LAB_02:'labs',
};

const STUDY_GUIDE = {
resp: `OXYGENATION & GASEOUS TRANSFER

UPPER vs LOWER AIRWAY:
Upper airway (above larynx): nasal passages, mouth, pharynx — NOT sterile.
Lower airway (below larynx): trachea, bronchi, bronchioles — STERILE.
Alveoli = site of gas exchange. Suctioning below the larynx requires sterile technique.

VENTILATION / RESPIRATION / OXYGENATION:
Ventilation = movement of air in/out of lungs.
External respiration: at alveoli — O2 enters blood, CO2 exits to be exhaled.
Internal respiration: at tissues — O2 leaves blood into cells, CO2 returns to blood.
Oxygenation = how well O2 reaches cells, tissues, organs.
Counting RR tells you about ventilation ONLY, not whether gas exchange is occurring.

HYPOXEMIA vs HYPOXIA:
Hypoxemia = low O2 in the BLOOD (PaO2 <80 mmHg) — comes first.
Hypoxia = low O2 in the TISSUES (SpO2 <90%) — results from hypoxemia if untreated.

COPD HYPOXIC DRIVE:
Normal stimulus to breathe = HIGH CO2 (elevated PaCO2).
In COPD: chronically elevated CO2 desensitizes the body — LOW O2 becomes the ONLY stimulus.
Too much supplemental O2 in a COPD patient removes their only stimulus to breathe → patient stops breathing → can be fatal.
Target SpO2 88-92% in COPD. Use Venturi mask for most precise delivery.

6 RESPIRATORY INSPECTION CHARACTERISTICS:
1. Skin and mucous membrane color (pale, cyanotic)
2. Cough and sputum — COCAF (Color, Odor, Consistency, Amount, Frequency)
   Sputum colors: white/clear=viral; yellow-green=bacterial; pink frothy=pulmonary edema; rust=TB; black=smoke inhalation
3. Rate, rhythm, depth, pattern, and effort
4. Symmetry of chest movements (asymmetry = problem on one side: obstruction, effusion, pneumothorax, splinting)
5. Shape — AP diameter: Normal AP:Lateral = 1:2. Barrel chest 1:1 = COPD/emphysema (chronic air trapping)
6. Spinal deformities and edema

PALPATION & PERCUSSION:
Respiratory excursion: thumbs at T10, patient takes deep breath — both sides expand equally. Asymmetry = pleurisy, fractured ribs, splinting.
Percussion sounds: Resonance=normal lung; Dullness=fluid/consolidation (pneumonia, effusion); Hyperresonance=trapped air (emphysema, pneumothorax); Flatness=solid tissue/bone.

AUSCULTATION — TECHNIQUE:
Slow deep breaths through open mouth. Diaphragm of stethoscope, between ribs (never over bone), compare side to side.
Normal sounds: Bronchial (over trachea); Broncho-vesicular (over sternum anteriorly, between scapulae posteriorly); Vesicular (lower lung fields).

ABNORMAL LUNG SOUNDS:
Crackles (Rales): inspiration; air bubbling through fluid in alveoli; CHF, pneumonia, pulmonary edema, atelectasis; CANNOT be cleared by coughing.
Rhonchi: expiration; air through secretions in bronchi; COPD, bronchitis; MAY clear with coughing.
Wheezes: expiration; air through narrowed airways; asthma, bronchospasm.
Pleural Friction Rub: both inspiration and expiration; inflamed pleural layers rubbing; pleuritis — grating/leathery sound.
Stridor: INSPIRATORY, harsh crowing sound; upper airway obstruction; EMERGENCY — anaphylaxis, croup, epiglottitis, foreign body.

9 BREATHING PATTERNS:
Eupnea: normal — 12-20 bpm, regular rhythm and depth.
Tachypnea: >24 bpm, fast and shallow; pneumonia, pulmonary edema, metabolic acidosis, sepsis, pain, fever.
Bradypnea: <10 bpm, slow; head injury, opioid OD, PaCO2 >45, neurological damage.
Apnea: complete absence of breathing; respiratory arrest, OSA episodes.
Kussmaul's: fast AND deep; metabolic acidosis (DKA) — lungs compensating by blowing off CO2.
Cheyne-Stokes: regular cycle of increasing then decreasing depth ending in apnea; damage to respiratory center.
Biot's: completely irregular bursts, no cycle; brain injury, increased ICP.
Orthopnea: SOB when lying flat, must sit upright; left HF — fluid shifts to lungs when supine.
Stridor (EMERGENCY): harsh crowing on inspiration; partial upper airway obstruction.

8 SIGNS OF RESPIRATORY DISTRESS:
1. Nasal flaring
2. Retractions — skin pulls inward between/below ribs
3. Accessory muscle use — neck, shoulder, abdomen
4. Grunting — forced exhalation against partially closed glottis, keeps positive pressure to prevent alveolar collapse
5. Orthopnea — SOB lying flat
6. Conversational dyspnea — can't complete sentences
7. Wheezing — expiratory — narrowed small airways
8. Stridor — INSPIRATORY — EMERGENCY

EARLY SIGNS OF HYPOXIA: Restlessness (FIRST SIGN), anxiety, confusion, tachycardia, tachypnea, hypertension, nasal flaring, accessory muscle use, pale skin.
LATE SIGNS OF HYPOXIA (LIFE-THREATENING): Bradycardia, bradypnea, extreme restlessness, severe dyspnea, decreased LOC/coma, hypotension, cyanosis of tongue and oral mucosa (BEST indicator of hypoxia), clubbing (chronic hypoxia).

COPD — CHRONIC BRONCHITIS ("Blue Bloater"):
Problem: inflammation + mucus hypersecretion — O2 can't get IN.
S&S: chronic productive cough, thick tenacious sputum, rhonchi, wheezing, hypoxemia/cyanosis, tachycardia, tachypnea, dyspnea, peripheral edema, orthopnea.
Treatment: bronchodilators, corticosteroids, expectorants, controlled O2/BiPAP, smoking cessation, pulmonary rehab, vaccinations.
#1 cause: smoking (90%).
Diagnostics: PFTs, CXR, ABGs.

COPD — EMPHYSEMA ("Pink Puffer"):
Problem: destruction of alveoli + air trapping — CO2 can't get OUT.
PFTs show increased residual volume — air cannot be fully exhaled.
S&S: barrel chest, pursed-lip breathing, difficulty exhaling, grunting, weight loss, tripod positioning, clubbing, accessory muscle use, orthopnea.
Treatment: same as bronchitis + pursed-lip breathing is CRITICAL for emphysema.

OBSTRUCTIVE SLEEP APNEA (OSA):
S&S: snoring/gasping/restlessness during sleep, apnea episodes 10-120 seconds, unrefreshing sleep, daytime sleepiness, morning headache (CO2 retained), dry mouth in AM.
Risk factors: age >40, male, overweight, neck >17" (M) or >16" (F), alcohol before sleep, smoking, sleep-inducing medications, large tonsils/tongue, small mandible.
Treatment: CPAP (first-line), BiPAP, side-lying positioning, weight loss ≥10%, no alcohol, no smoking, dental appliances.
DANGER: Sedatives, opioids, benzos, anesthesia = DANGEROUS in OSA — suppress respiratory drive.

SUPPLEMENTAL O2 DEVICES (apply when SpO2 <90% with symptoms — O2 = medication, requires order):
Exception: RN may give 2L NC in emergency without order, then get order after.
Nasal Cannula (NC): 1-6 L/min, FiO2 20-40%; prongs curve downward; humidify if >3 L/min.
Simple Face Mask: 6-10 L/min, FiO2 40-60%; minimum 6 L/min or CO2 rebreathes in dead space.
Partial Non-Rebreather: 8-11 L/min, FiO2 60-75%; reservoir bag must stay PARTIALLY inflated at all times.
Non-Rebreather (NRB): 10-15 L/min, FiO2 80-100%; short-term 1-1.5 hrs only; if fails → intubation.
Venturi Mask (BEST for COPD): most precise FiO2 delivery; 2L=24%, 4L=28%, 6L=31%, 8L=35%, 10L=40%, 15L=60%; target SpO2 88-92% for COPD.
Face Tent: claustrophobic patients needing humidified O2 who cannot tolerate a mask.

SUCTIONING:
Yankauer: suctions mouth/upper pharynx; NOT sterile; used for gurgling or visible secretions in upper airway.
Suction Catheter (lower airway): STERILE technique required; pre-oxygenate with 100% O2 before suctioning; suction on withdrawal ONLY; max 10 seconds per pass; max 3 passes per session; allow recovery between passes.
Complications of deep suctioning: mucosal trauma, hypoxia, bronchospasm, atelectasis, dysrhythmias.

NURSING INTERVENTIONS FOR RESPIRATORY PATIENTS:
Positioning: High Fowler's or orthopneic/tripod — gravity maximizes diaphragmatic excursion and lung expansion.
Incentive Spirometer (IS): purpose = prevent/reverse atelectasis; slow deep inhale → hold 3-5 sec → exhale; 10-20 times per hour.
Pursed-Lip Breathing: slows exhalation, keeps airways open, releases trapped CO2; CRITICAL for emphysema patients.
Peak Flow Meter: Green 80-100% = all clear; Yellow 50-80% = take bronchodilator; Red <50% = go to ED.
Hydration: thins secretions — makes them easier to mobilize and expectorate.
Smoking cessation, vaccinations (flu, pneumonia), infection control.

RESPIRATORY MEDICATIONS:
Codeine: antitussive opioid — SUPPRESSES cough reflex in medulla. Monitor RR and sedation level. SE: sedation, constipation, hypotension. CAUTION in COPD/OSA — further suppresses respiratory drive.
Guaifenesin (Mucinex): expectorant — thins mucus, PROMOTES productive cough (does NOT suppress). ESSENTIAL: adequate fluid intake for drug to work.

LABS & DIAGNOSTICS:
SpO2/Pulse Oximetry: normal 95-100%; COPD target 88-92%. Inaccurate with: nail polish, poor perfusion, CO poisoning, severe anemia.
ABGs (normal): pH 7.35-7.45; PaCO2 35-45 mmHg; HCO3- 22-26 mEq/L; PaO2 80-100 mmHg.
Sputum C&S: collect in AM before breakfast; deep cough into sterile container.
PPD (TB skin test): read at 48-72 hours; positive = redness AND induration (redness alone is NOT positive).
CXR/CT: detects pneumonia, atelectasis, pleural effusion, pneumothorax, COPD changes.
PFTs: measure lung volumes and capacities; emphysema shows increased residual volume.`,

cardio: `CARDIOVASCULAR — CIRCULATION & PERFUSION

KEY DEFINITIONS:
Circulation = blood flowing through heart and vessels.
Perfusion = O2 reaching capillary beds and tissues.
Ischemia = tissue alive but O2-deprived — REVERSIBLE if treated quickly.
Infarction (MI) = tissue DEAD — IRREVERSIBLE (prolonged ischemia leads to MI).

CONDUCTION SYSTEM:
SA Node = primary pacemaker (60-100 bpm).
AV Node → slight delay → Bundle of His → Left & Right Bundle Branches → Purkinje Fibers → ventricles contract.
If SA node fails → AV node takes over. If both SA and AV fail → Purkinje fibers fire at <40 bpm.

BLOOD FLOW THROUGH HEART:
Body → Vena Cava → Right Atrium → Tricuspid valve → Right Ventricle → Pulmonic valve → Lungs → Pulmonary Vein → Left Atrium → Mitral valve → Left Ventricle → Aortic valve → Body.
Atria RECEIVE blood. Ventricles PUMP blood. Valves prevent backflow.

EKG WAVES:
P wave = atrial depolarization → atria contract.
QRS = ventricular depolarization → ventricles contract.
T wave = ventricular repolarization → ventricles relax.
Flat T wave = hypokalemia. Tall T wave = hyperkalemia. Absent P wave = A-fib.

ANS — SYMPATHETIC vs PARASYMPATHETIC:
Sympathetic ("fight or flight"): increases HR, increases contractility; neurotransmitters = epinephrine and norepinephrine; acts on beta receptors; controls ALL blood vessels.
Atenolol (beta-blocker) blocks epinephrine/norepinephrine at beta receptors → decreases HR and cardiac workload.
Parasympathetic ("rest and digest"): decreases HR ONLY via vagus nerve; NO effect on contractility; NO significant vessel control; neurotransmitter = acetylcholine.

CARDIOVASCULAR ASSESSMENT:
Inspection: signs of distress, skin color, breathing effort; JVD assessed at 15-45 degrees → indicates right HF or fluid overload; edema, clubbing.
Palpation: skin temperature; pulse quality: 0=absent, 1+=weak/thready, 2+=normal, 3+=bounding; pitting edema: 1+=2mm, 2+=4mm, 3+=6mm, 4+=8mm; Thrill = vibration felt; Bruit = turbulence heard via auscultation.
Auscultation: S1 (LUB) = AV valves CLOSE = start of systole (mitral + tricuspid); S2 (DUB) = semilunar valves CLOSE = end of systole (aortic + pulmonic).
Valve auscultation sites (APETM): A (Aortic) = 2nd RIGHT ICS; P (Pulmonic) = 2nd LEFT ICS; E (Erb's point) = 3rd LEFT ICS; T (Tricuspid) = 4th LEFT ICS; M (Mitral) = 5th ICS left midclavicular line.

HEART FAILURE:
Left HF: LV can't pump → blood backs up into LUNGS → pulmonary congestion.
Etiology of left HF: MI, hypertension, cardiomyopathy.
S&S left HF: SOB/dyspnea, orthopnea, CRACKLES (hallmark), wheezing, pink frothy sputum, tachypnea, tachycardia, confusion, fatigue, exercise intolerance.
Right HF: RV can't pump → blood backs up into PERIPHERAL VEINS → systemic congestion.
Etiology of right HF: most commonly CAUSED BY left HF.
S&S right HF: peripheral edema, JVD, ascites, weight gain, enlarged liver/spleen, fatigue, weakness, exercise intolerance.
BNP: released when LV is stretched; elevated = left HF; higher BNP = more severe CHF. Normal <100 pg/mL.
Echocardiogram: evaluates heart structure, function, valves. Normal EF 50-75%. EF <40% = systolic heart failure.

PERIPHERAL VASCULAR DISEASE — 5 P's + T:
Pain, Pallor, Pulse, Paresthesia, Paralysis, Temperature.

PAD (Peripheral Arterial Disease):
Problem: plaque narrows arteries → not enough blood reaching legs.
S&S: pale/cool/cyanotic skin, weak or absent peripheral pulses, no leg hair, thick toenails, ischemic wounds on TOES AND FEET, intermittent claudication (leg pain with walking, relieved by rest).
Nursing: keep legs DOWN (gravity assists arterial flow to feet); daily foot care; smoking cessation; no restrictive clothing or crossing legs.

PVD (Peripheral Venous Disease):
Problem: damaged/incompetent valves → blood pools in legs.
S&S: brownish-red discoloration, varicose veins, pitting edema, stasis ulcers on LOWER LEG (above ankle).
Nursing: keep legs UP (gravity assists venous return); compression stockings; ambulation (activates calf muscle pump); no crossing legs; ankle circles and calf pumps.

NURSING INTERVENTIONS FOR CV CONDITIONS:
Monitor VS, I&O, daily weights (report gain >2 lb/day or >5 lb/week), edema.
O2 as ordered, HOB elevated; DASH diet (low sodium, low fat); manage anxiety (SNS activation increases cardiac workload).
Activity as tolerated; cluster care; fall precautions.
Patient teaching: low-sodium diet, no smoking, medication compliance, daily weights, foot care for PAD/PVD, compression stockings for PVD, leg exercises/ankle circles.

CV MEDICATIONS:
atenolol (Tenormin): beta-blocker; blocks NE/epi at beta receptors → decreases HR and cardiac workload; used for HTN, angina, MI prevention. Monitor BP, EKG, and pulse. Rise slowly — orthostatic hypotension.
enalapril (Vasotec): ACE inhibitor — antihypertensive; blocks angiotensin II → vasodilation → decreases BP; used for HTN. Key SE = DRY COUGH. Monitor BP, BUN, creatinine, electrolytes.
nitroglycerin (Nitrostat/Nitro-Dur): vasodilator; dilates coronary arteries → increases blood flow to ischemic heart, decreases BP; used for angina. Check BP before AND after; patient must SIT before receiving; headache = common and EXPECTED SE (decreases with therapy); rise slowly — orthostatic hypotension.
digoxin (Lanoxin): cardiac glycoside — positive inotrope; increases force of contraction, slows HR; used for HF and A-fib. Hold if apical pulse <60 bpm — check for 1 FULL MINUTE. Therapeutic level: 0.5-2 mg/mL. LOW K+ or LOW Mg2+ → TOXICITY. Toxicity signs: abdominal pain, anorexia, N/V, YELLOW/GREEN HALOS (visual disturbance), bradycardia.
atorvastatin (Lipitor): statin — lipid-lowering; decreases LDL synthesis → decreases plaque formation; used for CVD prevention. Monitor liver enzymes and lipid panel. Muscle pain → check CK immediately (rhabdomyolysis risk).

CARDIAC LABS:
Troponin: most specific marker for MI; rises 2-3 hours post-MI; stays elevated 1-2 weeks; draw FIRST for suspected MI. Normal <0.1 ng/mL.
CK-MB: rises 3-6 hours post-MI; clears in 1-2 days; best for detecting re-infarction. Normal 55-170 U/L.
BNP: released by LV when overstretched; elevated = left HF; higher = more severe. Normal <100 pg/mL.
LDL: "bad" cholesterol — deposits plaque on vessel walls. Normal <100 mg/dL.
HDL: "good" cholesterol — removes LDL from blood. Normal >60 mg/dL.
PT/INR: monitors warfarin; therapeutic INR = 2-3.
PTT/aPTT: monitors heparin; therapeutic = 1.5-2x normal.`,

abg: `ABG & ACID-BASE BALANCE

3 WAYS THE BODY MAINTAINS ACID-BASE BALANCE (fastest to slowest):
1. Buffers — FASTEST, act instantly, no organ required. Neutralize acids/bases immediately.
2. Lungs — control CO2, respond in MINUTES. Too acidic → breathe fast, blow off CO2. Too alkaline → breathe slow, retain CO2.
3. Kidneys — control HCO3-, respond in DAYS (slowest). Too acidic → retain HCO3-, excrete H+. Too alkaline → excrete HCO3-.

NORMAL ABG VALUES:
pH: 7.35-7.45. <7.35 = ACIDOSIS. >7.45 = ALKALOSIS.
PaCO2: 35-45 mmHg (respiratory value — CO2 is an ACID).
HCO3-: 22-26 mEq/L (metabolic value — HCO3- is a BASE).
PaO2: 80-100 mmHg.

KEY RULES:
CO2 is an ACID — moves OPPOSITE direction from pH (↑CO2 = ↓pH).
HCO3- is a BASE — moves SAME direction as pH (↓HCO3- = ↓pH).
ROME mnemonic: Respiratory = Opposite; Metabolic = Equal.

TIC-TAC-TOE METHOD (3 steps):
Step 1: Is pH acid (<7.35), normal, or base (>7.45)?
Step 2: Is PaCO2 acid (>45), normal, or base (<35)?
Step 3: Is HCO3- acid (<22), normal, or base (>26)?
Whichever value MATCHES the pH direction = the CAUSE.
CO2 matches → Respiratory disorder. HCO3- matches → Metabolic disorder.

THE 4 ABG DISORDERS:

RESPIRATORY ACIDOSIS: pH↓ (<7.35), PaCO2↑ (>45).
Cause: hypoventilation — CO2 retained.
Causes: COPD, opioid OD, apnea, airway obstruction, CHF, pneumonia.
S&S: confusion, decreased LOC, tachycardia, tachypnea, headache, dizziness.
Treatment: O2, ventilatory support, naloxone if opioid OD, treat cause.

RESPIRATORY ALKALOSIS: pH↑ (>7.45), PaCO2↓ (<35).
Cause: hyperventilation — CO2 blown off.
Causes: anxiety, panic attack, pain, sepsis, fever.
S&S: hyperventilation, tingling/numbness, headache, dizziness, hypokalemia.
Treatment: slow breathing, rebreather bag, treat pain/anxiety/cause.

METABOLIC ACIDOSIS: pH↓ (<7.35), HCO3-↓ (<22).
Cause: acid buildup or base (HCO3-) loss.
Causes: renal failure, DKA, diarrhea (losing HCO3-), sepsis/lactic acid, ASA OD.
S&S: KUSSMAUL'S breathing (rapid deep — lungs compensating), headache, confusion, weakness, N/V, hyperkalemia.
Treatment: treat cause, possible bicarbonate order.

METABOLIC ALKALOSIS: pH↑ (>7.45), HCO3-↑ (>26).
Cause: acid loss or base gain.
Causes: vomiting, NG suction, furosemide (losing K+ and H+), excess antacids.
S&S: hypoventilation (compensatory), dizziness, tingling, HYPERTONIC muscles, hypokalemia.
Treatment: treat cause, K+ replacement, antiemetics.

CLINICAL CLUES:
COPD + altered LOC → respiratory acidosis.
Anxious patient hyperventilating → respiratory alkalosis → tingling.
DKA + Kussmaul's breathing → metabolic acidosis.
Severe diarrhea → metabolic acidosis (losing HCO3-).
Post-op on opioids, hypoventilating → respiratory acidosis.
Vomiting/NG suction → metabolic alkalosis (losing stomach acid/HCl).
Furosemide without K+ replacement → metabolic alkalosis.
ASA overdose → metabolic acidosis.`,

fluids: `FLUIDS & ELECTROLYTES — FLUID BALANCE

FLUID COMPARTMENTS:
ICF (Intracellular Fluid): inside all body cells — LARGEST compartment. Major ions: K+, Mg2+, phosphate.
ECF (Extracellular Fluid) — 3 subtypes:
  Interstitial: between cells and blood vessels — where EDEMA forms.
  Intravascular: plasma inside blood vessels. Main ions: Na+, Cl-, HCO3-, albumin.
  Transcellular: CSF, pleural fluid, peritoneal, synovial, digestive juices.

THIRD SPACING: fluid trapped in a space the body cannot access or use.
Examples: ascites, pericardial effusion, burn blisters, pleural effusion.
DANGER: circulating volume DROPS even though fluid has NOT left the body.

FLUID MOVEMENT MECHANISMS:
Osmosis: WATER moves from LOW to HIGH concentration (passive, no ATP required).
Diffusion: SOLUTES move from HIGH to LOW concentration (passive, no ATP required).
Filtration: water + particles move from HIGH to LOW pressure (passive).
Active Transport: electrolytes move from LOW to HIGH concentration — requires ATP — ONLY energy-requiring mechanism.

ROLE OF ADH IN FLUID BALANCE:
Trigger: low fluid volume or decreased BP → posterior pituitary releases ADH.
Effect: kidneys RETAIN water → increased blood volume → raises BP.
ADH released → urine concentrated (dark, small volume), specific gravity >1.030.
ADH suppressed → urine dilute (pale, large volume), specific gravity <1.002.
RAAS: Low fluid → kidneys release renin → angiotensin II → kidneys hold Na+ and water → increased BP. ACE inhibitors block angiotensin II → decreased BP (enalapril).
SIADH: too MUCH ADH → too much water retained → dilutional hyponatremia → confusion, seizures.
Diabetes Insipidus: too LITTLE ADH → massive water loss → dehydration → hypernatremia.

10 SIGNS OF HYPOVOLEMIA (NEED FOR FLUIDS):
1. Thirst — FIRST SIGN
2. Headache
3. Fatigue
4. Concentrated/decreased urine
5. Increased HR and low BP (tachycardia, hypotension, thready pulse)
6. Dry mouth and eyes
7. Lack of coordination
8. Muscle cramps
9. Constipation
10. Weakness, trembling, lack of mental clarity
Also: elevated temperature, dry mucous membranes, poor skin turgor, capillary refill >3 sec, AMS, elevated BUN and Na+, elevated Hct, elevated urine specific gravity >1.030.

HYPERVOLEMIA — SIGNS & SYMPTOMS:
Causes: excess fluid/Na+ intake, CHF, renal failure, liver failure, low albumin.
S&S: rapid weight gain, JVD, pitting/dependent edema, crackles, dyspnea, bounding pulse, hypertension, increased RR, AMS.
Labs: decreased BUN, decreased Hct (hemodilution), decreased urine specific gravity (<1.002), decreased Na+ (hemodilution).

FLUID MONITORING RULES:
Daily weight: same time, same scale, same clothing. Report gain >2 lb in 1 day OR >5 lb in 1 week.
Minimum urine output = 30-50 mL/hour (indicates adequate perfusion).
BUN elevated alone = dehydration (kidneys functioning fine).
Both BUN + creatinine elevated = suspect RENAL FAILURE.

NURSING INTERVENTIONS — INCREASING FLUIDS (hypovolemia):
Assess and offer fluid preferences; encourage oral fluids throughout day; IV fluids as ordered (isotonic 0.9% NS); monitor I&O, daily weights, VS, mental status; mouth care for dry mucous membranes; always have fluids available.

NURSING INTERVENTIONS — RESTRICTING FLUIDS (hypervolemia):
Measure ALL intake; reserve liquids for BETWEEN meals (not with meals); offer ice chips to manage thirst; do NOT leave fluids at bedside; diuretics as ordered; low-sodium diet; monitor I&O, daily weights, lung sounds; HOB elevated.

IV FLUID TONICITY:
ISOTONIC (no fluid shift — stays in ECF): same osmolality as blood.
  Examples: 0.9% Normal Saline (NS), Lactated Ringer's (LR).
  Uses: hypovolemia, dehydration, fast volume replacement; LR for blood loss/trauma/surgery.
  CAUTION: risk of fluid overload — monitor in CHF.

HYPOTONIC (cells swell — water moves INTO cells): lower osmolality.
  Examples: 0.45% NS, 0.33% NS, D5W.
  Uses: intracellular dehydration, DKA.
  NEVER use with: increased ICP, stroke, or head injury — causes cerebral edema.

HYPERTONIC (cells shrink — water moves OUT of cells): higher osmolality.
  Examples: D5NS, D5 1/2NS, D5LR, D10W, 3% NS.
  Uses: cerebral edema, severe hyponatremia, volume expansion.
  CAUTION: must run SLOW — risk of hypervolemia; monitor blood glucose.`,

elytes: `ELECTROLYTE IMBALANCES

SODIUM (Na+) — Normal: 135-145 mEq/L — ECF main ion, fluid volume, nerve impulses:
HYPONATREMIA (<135):
  Causes: diuretics, GI loss, excess water intake, hypotonic fluids, SIADH.
  S&S: AMS/confusion, N/V, weakness, muscle cramps, SEIZURES. Brain cells SWELL (low salt → water rushes into cells).
  Treatment: increase oral Na+, IV Normal Saline, fluid restriction if water overload.
HYPERNATREMIA (>145):
  Causes: excess Na+ intake, dehydration, profuse sweating, diabetes insipidus, hypertonic tube feeds.
  S&S: thirst, elevated temp, dry sticky mucous membranes, AMS, seizures. Brain cells SHRINK (high salt → water pulled out of cells).
  Treatment: restrict Na+, increase water intake, IV D5W.

POTASSIUM (K+) — Normal: 3.5-5.0 mEq/L — ICF main ion, cardiac rhythm, muscle function:
HYPOKALEMIA (<3.5):
  #1 Cause: FUROSEMIDE (loop diuretic). Other causes: vomiting, diarrhea, NG suction, anorexia/bulimia.
  S&S: N/V, muscle weakness, dysrhythmias, paresthesias, FLAT T wave on ECG.
  KEY: Low K+ INCREASES DIGOXIN TOXICITY — always monitor K+ when patient is on both furosemide and digoxin.
  Treatment: K+-rich foods, KCl supplements PO or IV, monitor digoxin levels.
HYPERKALEMIA (>5.0):
  Causes: renal failure, K+-sparing diuretics, acidosis, hemolyzed sample.
  S&S: muscle weakness, dysrhythmias, flaccid paralysis, intestinal colic, TALL T wave on ECG.
  Treatment: monitor I&O and K+, restrict K+ foods, cardiac monitoring.

CALCIUM (Ca2+) — Normal: 8.5-10.5 mg/dL — bones, nerve impulses, muscle contraction:
HYPOCALCEMIA (<8.5):
  Causes: hypoparathyroidism (especially AFTER thyroid/parathyroid surgery!), Vitamin D deficiency, alkalosis, malabsorption, pancreatitis.
  S&S: muscle cramps, tetany, seizures, cardiac irritability.
  Trousseau's sign: inflate BP cuff for 3 minutes → carpopedal SPASM = positive for hypocalcemia.
  Chvostek's sign: tap facial nerve → facial TWITCH = positive for hypocalcemia.
  Treatment: increase Ca2+ and Vit D; severe cases → seizure precautions + parenteral calcium.
HYPERCALCEMIA (>10.5):
  Causes: hyperparathyroidism, malignant bone disease, prolonged immobilization, excess supplementation, thiazide diuretics.
  S&S: N/V, muscle weakness, bradycardia, constipation, kidney stones, polyuria.
  Treatment: increase fluids, increase fiber, stop Ca2+ supplements.

MAGNESIUM (Mg2+) — Normal: 1.3-2.1 mEq/L — nerve/cardiac electrical activity, maintains K+:
HYPOMAGNESEMIA (<1.3):
  Causes: chronic alcoholism, malabsorption, DKA, prolonged NG suctioning.
  S&S: neuromuscular irritability, dysrhythmias, disorientation; INCREASES sensitivity to digoxin (same risk as low K+).
  Treatment: Mg2+-rich foods (greens, nuts, grains), avoid alcohol, monitor digoxin.
HYPERMAGNESEMIA (>2.1):
  Causes: renal failure, excess Mg2+ intake from antacids or laxatives.
  S&S: HYPOACTIVE reflexes (key finding), bradycardia, flushing and warmth, hypotension, drowsiness/lethargy.
  Treatment: monitor reflexes, restrict high-Mg foods, avoid Mg2+-based antacids and laxatives.

KEY RELATIONSHIPS:
Both hypokalemia AND hyperkalemia → cardiac dysrhythmias — always monitor ECG.
Both low K+ AND low Mg2+ with digoxin = HIGH toxicity risk.
Furosemide = #1 cause of hypokalemia.
After thyroid/parathyroid surgery → watch for hypocalcemia (tetany, Trousseau's, Chvostek's).`,

iv: `IV THERAPY & BLOOD PRODUCTS

PERIPHERAL IV ACCESS:
Gauge: lower number = larger lumen (18g > 22g). Replace peripheral IV every 72 hours.
Uses: IV fluids, medications, blood products for short-term therapy.

IV COMPLICATIONS (5 TYPES):

1. INFILTRATION:
   Cause: NON-vesicant fluid leaks into tissue — catheter dislodged or misplaced.
   S&S: swelling, pale/cool/hard skin at site, tender/burning, slow or stopped IV flow.
   Treatment: STOP IV; restart above the site or in the other arm; elevate the limb.

2. EXTRAVASATION:
   Cause: VESICANT drug leaks into tissue → causes tissue necrosis.
   Vesicant examples: chemotherapy, dopamine, dextrose >10%, TPN, IV nitroglycerin, acyclovir.
   Early S&S: same as infiltration (swelling, pale/cool skin). Late S&S: blistering, tissue necrosis, blanching.
   Treatment: STOP immediately; call MD; give antidote as ordered; cold compress; elevate limb; document.
   KEY DIFFERENCE: Infiltration = non-vesicant = no tissue destruction. Extravasation = vesicant = causes necrosis. Both require STOP IV immediately.

3. PHLEBITIS:
   Cause: vein inflammation from chemical or mechanical irritation.
   S&S: redness, pain, warmth, edema, palpable vein cord.
   Treatment: STOP IV → COLD compress; assess circulatory impairment; notify MD if fever.

4. THROMBOPHLEBITIS:
   Cause: clot + inflammation from untreated phlebitis.
   S&S: same as phlebitis PLUS slow flow, hard cord (clot present).
   Treatment: STOP IV; restart on OPPOSITE side; ALL new equipment; WARM moist compress; call MD.
   Phlebitis = COLD compress. Thrombophlebitis = WARM compress (clot present).

5. IV SITE INFECTION:
   Cause: poor aseptic technique or IV not changed every 72 hours.
   S&S: redness, swelling, EXUDATE (pus), fever.
   Treatment: remove IV; sterile dressing; call MD; antibiotics; culture site.

CENTRAL VASCULAR ACCESS:
Non-tunneled CVC: inserted into subclavian or jugular vein by MD; X-RAY MUST CONFIRM PLACEMENT BEFORE FIRST USE.
PICC Line: inserted in antecubital fossa → advanced to superior vena cava; long-term use, prolonged antibiotics, home care; RN assesses site AND catheter length every shift — length change = MIGRATION.
Implanted Port (Mediport): surgically implanted under skin; long-term use; accessed with HUBER NEEDLE ONLY — sterile procedure; concealed under skin when not accessed.

BLOOD PRODUCTS — INDICATIONS:
PRBCs: raise Hgb/Hct; restore O2-carrying capacity; severe anemia, significant blood loss/trauma/hemorrhage.
Platelets: low platelet count, abnormal platelet function, clotting disorders.
Plasma/FFP: clotting factor deficits, immune deficiencies, warfarin reversal.
NOTE: IV fluids restore volume ONLY — CANNOT restore O2-carrying capacity or replace clotting factors. Only blood products can do this.

BLOOD TRANSFUSION — TIME RULES & SETUP:
Initiate within 30 MINUTES of release from blood bank.
Infuse in NOT LESS than 2 hours, NOT MORE than 4 hours.
If not complete in 4 hours → STOP and WASTE.
Stay with patient for first 15 MINUTES and retake vital signs.
2-NURSE CHECK REQUIRED — always, before hanging: right patient (2 identifiers), right blood type (ABO and Rh match), expiration date on blood bag, blood bag ID number matches paperwork.
IV fluid: ONLY 0.9% Normal Saline — dextrose causes RBC lysis.
IV gauge: 18-20 gauge. Use Y-tubing. If dextrose running → completely new IV line.
Pre-meds if ordered: acetaminophen, diphenhydramine.

5 TRANSFUSION REACTIONS:
UNIVERSAL FIRST STEP FOR ALL REACTIONS: STOP transfusion IMMEDIATELY. Replace tubing and hang 0.9% NS. Notify MD. Then identify the specific reaction type.

1. FEBRILE:
   Cause: sensitivity to WBCs, plasma proteins, platelets.
   S&S: fever, chills, warm flushed skin, aches.
   Treatment: STOP; hang NS; notify MD; acetaminophen as ordered.

2. ALLERGIC:
   Cause: allergy to blood components.
   S&S: flushing, itching, hives (urticaria), wheezing. Severe = ANAPHYLAXIS.
   Treatment: STOP; hang NS; antihistamine for mild; epinephrine for anaphylaxis; notify MD.

3. BACTERIAL:
   Cause: contaminated blood product.
   S&S: HIGH fever, severe chills, severe hypotension, vomiting, diarrhea.
   Treatment: STOP; hang NS; notify MD; blood cultures; antibiotics as ordered.

4. HEMOLYTIC (MOST SERIOUS AND MOST PREVENTABLE):
   Cause: INCOMPATIBLE BLOOD — wrong blood given to wrong patient.
   S&S: fever, chills, chest pain, dyspnea, tachycardia, hypotension → FATAL.
   Treatment: STOP IMMEDIATELY; new NS via NEW tubing (not blood tubing); notify MD STAT; send: blood bag + tubing + venous sample + FIRST VOIDED URINE to lab; treat shock.
   Prevention: 2-nurse verification check before hanging — 99% preventable.

5. CIRCULATORY OVERLOAD:
   Cause: too much volume or infused too fast.
   S&S: persistent cough, crackles, hypertension, JVD.
   Treatment: slow or STOP transfusion; sit patient upright; monitor VS; notify MD; anticipate furosemide (Lasix).`,

mgmt: `MANAGEMENT & COST CONTAINMENT

CAUSES OF ESCALATING HEALTHCARE COSTS:
1. Aging population → more chronic conditions, long-term care, specialty care.
2. Higher survival rates → costly long-term and intensive care.
3. Administrative waste from insurance system complexity.
4. Lack of hospital competition → hospital consolidation → unchecked price increases.
5. Third-party payers insulate consumers from the real cost of care.
6. Rising cost of medical technology and prescriptions.
7. Overuse: unnecessary diagnostic tests, longer lengths of stay.
8. Cost and waste of supplies; complications patients experience (preventable events add cost).
By 2028: $6.2 trillion projected ($18,000/person). High cost does NOT equal high quality.

ANA RESOURCE STEWARDSHIP STANDARD:
"The registered nurse utilizes appropriate resources to plan, provide, and sustain evidence-based nursing services that are safe, effective, financially responsible, and used judiciously."

NURSES' ROLE IN COST CONTAINMENT:
SUPPLIES: Only bring needed supplies into the patient room (unused room supplies must be discarded); scan barcodes timely to capture all charges; avoid unnecessary prepackaged kits.
PRACTICE:
- Thorough assessments early (e.g., catching reddened areas → implement turn schedule → prevent costly pressure injuries).
- Infection control: CAUTI (catheter-associated UTI) and VAP (ventilator-associated pneumonia) are preventable nosocomial infections that add significant costs.
- Prioritize using Maslow → ABC → CURE.
- Delegate to UAPs appropriately.
- Cluster cares; document for continuity (prevents duplicate testing).

SHIFTING PARADIGMS — PAST vs FUTURE:
Past: payment for sick care triggered by visits and procedures; provider-centric; no accountability for quality; nursing not recognized.
Future: payment for prevention and care coordination; patient as partner; value-based payment ("How well did patients do?"); nursing advocating for patients; focus on excellence and patient experience.`,

meds: `UNIT 2 MEDICATIONS

CARDIOVASCULAR MEDICATIONS:
atenolol (Tenormin) — Beta-blocker:
  Action: blocks norepinephrine and epinephrine at beta receptors → decreases HR, decreases cardiac workload.
  Use: HTN, angina, MI prevention.
  Nursing: monitor BP, EKG, and pulse; dizziness/orthostatic hypotension → rise slowly.

enalapril (Vasotec) — ACE Inhibitor:
  Action: blocks angiotensin II conversion → vasodilation → decreases BP.
  Use: HTN.
  Key SE: DRY COUGH (hallmark of ACE inhibitors).
  Nursing: monitor BP, BUN, creatinine, electrolytes; dizziness/hypotension.

nitroglycerin (Nitrostat SL / Nitro-Dur patch) — Vasodilator (nitrate):
  Action: potent vasodilator; dilates coronary arteries → increases blood flow to ischemic heart; reduces BP.
  Use: angina, HTN emergency.
  Nursing: check BP BEFORE AND AFTER administration; patient MUST SIT before receiving (vasodilation → BP drop → fall risk); headache = COMMON and EXPECTED SE (caused by vasodilation, decreases with continued therapy); rise slowly.

digoxin (Lanoxin) — Cardiac Glycoside (positive inotrope):
  Action: increases force of cardiac contraction; slows and strengthens HR.
  Use: HF and A-fib.
  Nursing: HOLD if apical pulse <60 bpm — check for 1 FULL MINUTE before giving. Therapeutic range: 0.5-2 mg/mL. LOW K+ or LOW Mg2+ → TOXICITY risk.
  Toxicity signs: abdominal pain, anorexia, N/V, YELLOW/GREEN HALOS (visual), bradycardia.

atorvastatin (Lipitor) — Statin:
  Action: lowers serum cholesterol → decreases LDL synthesis → decreases plaque formation.
  Use: CVD prevention.
  Nursing: monitor liver enzymes; monitor serum cholesterol; muscle pain → check CK immediately (rhabdomyolysis risk).

ANTICOAGULANTS:
heparin sodium — Short-term IV/SQ anticoagulant:
  Action: inhibits thrombin and Factor Xa → prevents clot formation.
  Use: DVT, PE, A-fib, ACS.
  Monitor: PTT or aPTT (therapeutic = 1.5-2x normal).
  Antidote: PROTAMINE SULFATE.
  Route: SQ abdomen or IV.
  Nursing: no IM injections; full bleeding precautions.

enoxaparin (Lovenox) — LMWH (Low Molecular Weight Heparin):
  Action: prevents DVT/PE.
  KEY advantage: does NOT require routine serum monitoring (unlike heparin).
  Route: SQ abdomen ONLY.
  Use: home/nursing home use, long-term.
  No specific antidote.

warfarin (Coumadin) — Long-term oral anticoagulant:
  Action: inhibits Vitamin K-dependent clotting factors.
  Use: chronic A-fib, DVT/PE prevention, mechanical heart valves.
  Monitor: PT/INR — therapeutic INR = 2-3.
  Antidote: VITAMIN K.
  Teaching: AVOID green leafy vegetables (contain Vitamin K which counteracts warfarin); consistent Vit K intake key — do not suddenly start or stop.

BLEEDING PRECAUTIONS (ALL anticoagulants):
Use electric razor; soft toothbrush; no aspirin/NSAIDs; stool softeners (avoid straining); wear shoes/slippers; blow nose gently.
Nurse: no IM injections; no rectal temps.
Report to provider: bleeding >5 min, hematuria, black/tarry stools, petechiae, new headache, abdominal pain, bruising without injury.

DIURETICS & ELECTROLYTE SUPPLEMENTS:
furosemide (Lasix) — Loop diuretic (K+-LOSING):
  Action: inhibits Na+/K+/Cl- reabsorption in loop of Henle → excretes water, Na+, K+.
  Use: edema from CHF, excess fluid volume.
  #1 SE: HYPOKALEMIA.
  IV rate: 20-40 mg/min — FASTER = OTOTOXICITY (permanent hearing loss, tinnitus).
  Other SE: dehydration, orthostatic hypotension, photosensitivity, Stevens-Johnson Syndrome.
  Nursing: monitor K+, BP, pulse; daily weights; I&O; lung sounds; give in AM (avoid disrupted sleep from diuresis); if on digoxin: low K+ from furosemide → digoxin toxicity.

spironolactone (Aldactone) — K+-SPARING diuretic:
  Action: blocks aldosterone → conserves K+, excretes Na+/water.
  Key SE: HYPERKALEMIA.
  Teaching: avoid salt substitutes (contain K+); avoid K+-rich foods.
  Nursing: monitor K+, BP, I&O; daily weights; give in AM.

potassium chloride (K-Dur) — HIGH ALERT medication:
  PO: give WITH FOOD (very irritating to GI tract).
  IV: MUST be diluted — NEVER give IV push → CARDIAC ARREST.
  Standard IV dose: 20 mEq in 100 mL NS over 1 hour.
  Contraindicated in: hyperkalemia, severe renal disease.

calcium carbonate (Tums / Os-Cal):
  Use: treatment and prevention of hypocalcemia.
  SE: arrhythmias, constipation.
  Nursing: monitor Trousseau's and Chvostek's signs; observe for paresthesias and muscle twitching; do NOT give to hypercalcemic patients; monitor for kidney stones.

RESPIRATORY MEDICATIONS:
codeine — Antitussive (opioid):
  Action: suppresses cough reflex in medulla.
  Nursing: monitor RR and sedation level.
  SE: sedation, constipation, hypotension.
  CAUTION: COPD/OSA — further suppresses respiratory drive. Do not give with CNS depressants.

guaifenesin (Mucinex) — Expectorant:
  Action: thins/loosens mucus → promotes productive cough. Does NOT suppress cough.
  ESSENTIAL: adequate fluid intake (water) for drug to work — without fluids it is ineffective.
  Nursing: encourage increased fluid intake; assess sputum production; give with full glass of water.

prednisone / methylprednisolone (Deltasone / Solu-Medrol) — Corticosteroid:
  Action: inhibits and suppresses inflammation.
  Use: severe asthma, COPD exacerbation.
  KEY SE: RAISES BLOOD SUGAR (hyperglycemia) — monitor blood glucose closely, especially in diabetics.
  Other SE: HTN, weight gain, moon face, increased infection risk, oral thrush (fungal), mood swings.

albuterol / ipratropium (Ventolin / Atrovent) — Bronchodilator:
  Action: relaxes bronchial smooth muscle → dilates airways.
  Use: asthma, COPD.
  SE: dry mouth, trembling, nervousness, palpitations, tachycardia, muscle cramps, N/V/D.

ENDOCRINE & GI MEDICATIONS:
Humulin R (Regular) — Fast-acting insulin — CLEAR:
  Onset: 30-60 min. Peak: 2-4 hours. Duration: 5-7 hours.
  ONLY insulin that can be given IV.
  Nursing: monitor blood sugar before giving; food must be available at or before peak (2-4 hrs); watch for hypoglycemia at peak (mid-morning if given at 0700); SQ injection 2 inches from umbilicus; if hypoglycemic and AWAKE → offer juice.

Humulin N (NPH) — Intermediate-acting insulin — CLOUDY:
  Onset: 2-4 hours. Peak: 4-10 hours. Duration: 10-16 hours.
  CANNOT be given IV (cloudy = not for IV).
  Nursing: watch for hypoglycemia at peak (4-10 hrs → afternoon/evening if given at 0700); same SQ technique.

loperamide (Imodium) — Anti-diarrheal:
  Action: inhibits peristalsis → slows bowel movements.
  DO NOT GIVE with abdominal pain of UNKNOWN cause.
  DO NOT GIVE for ACUTE INFECTIOUS diarrhea — body needs to expel the organism.
  Nursing: assess stool frequency and consistency; assess for dehydration.`,

labs: `LAB VALUES & DIAGNOSTICS REFERENCE

COMPLETE BLOOD COUNT (CBC):
WBC (White Blood Cell count): Normal 5,000-10,000/mm3.
  HIGH: infection or inflammation.
  LOW: leukopenia → immunocompromised, unable to fight infection.
WBC Differential: measures percentage of each leukocyte type (neutrophils 55-70%, lymphocytes 20-40%, monocytes 2-8%, eosinophils 1-4%, basophils 0.5-1%).
RBC (Red Blood Cell count): Male 4.7-6.1; Female 4.2-5.4. RBCs contain hemoglobin which carries O2.
  HIGH: polycythemia or dehydration (hemoconcentration).
  LOW: anemia → decreased O2 delivery.
Hemoglobin (Hgb): Female 12-16 g/dL; Male 14-18 g/dL.
  HIGH: polycythemia or dehydration (hemoconcentration).
  LOW: anemia → decreased O2 delivery → fatigue, dyspnea → indication for PRBC transfusion.
Hematocrit (Hct): Female 37-47%; Male 42-52%.
  HIGH: hemoconcentration from dehydration.
  LOW: anemia, hemodilution (fluid overload), or bleeding.
Platelets (PLT): Normal 150,000-400,000/mm3.
  HIGH: thrombocytosis → increased clot risk.
  LOW: thrombocytopenia → increased bleeding risk → indication for platelet transfusion.

COMPLETE METABOLIC PANEL (CMP/BMP):
Sodium (Na+): Normal 135-145 mEq/L. High = hypernatremia (cells shrink, thirst, AMS, seizures). Low = hyponatremia (brain cells swell, confusion, seizures).
Potassium (K+): Normal 3.5-5.0 mEq/L. High = hyperkalemia (TALL T waves, dysrhythmias, flaccid paralysis). Low = hypokalemia (FLAT T waves, muscle weakness, dysrhythmias, increased digoxin toxicity).
Calcium (Ca2+): Normal 8.5-10.5 mg/dL. High = hypercalcemia (N/V, bradycardia, constipation, kidney stones). Low = hypocalcemia (muscle cramps, tetany, seizures, Trousseau's, Chvostek's).
Magnesium (Mg2+): Normal 1.3-2.1 mEq/L. High = hypermagnesemia (hypoactive reflexes, bradycardia, flushing, hypotension). Low = hypomagnesemia (dysrhythmias, neuromuscular irritability, increased digoxin sensitivity).
Glucose: Normal 70-110 mg/dL. High = hyperglycemia (polyuria, polydipsia, critical in DKA, seen with corticosteroid use). Low = hypoglycemia (shakiness, diaphoresis, confusion, tachycardia).
BUN (Blood Urea Nitrogen): Normal 10-20 mg/dL. High BUN alone = dehydration (kidneys working fine). High BUN + high creatinine = suspect RENAL FAILURE.
Creatinine: Normal 0.5-1.3 mg/dL. BETTER indicator of kidney function than BUN. High = impaired GFR/kidney disease → restrict K+ foods when elevated (kidneys cannot excrete K+). Low = not clinically significant.
Albumin: Normal 3.5-5.0 g/dL. Low (<3.5) = malnutrition → impairs wound healing; affects drug binding (warfarin, digoxin affected by albumin levels). High = dehydration (hemoconcentration).
Urine Specific Gravity: Normal 1.002-1.030. >1.030 = concentrated urine = hypovolemia/dehydration. <1.002 = dilute urine = hypervolemia/fluid volume excess.
Hemoglobin A1C: Normal 4-5.9%. Measures average blood glucose over 2-3 months. Used to diagnose and monitor diabetes treatment.

ROUTINE URINALYSIS (UA):
Normal: color light amber to yellow, clear, aromatic odor, pH 5-9, protein <20 mg/dL, glucose none, ketones none, WBC 0-4, RBC ≤2, nitrates negative.
Abnormal findings: protein (kidney disease), glucose (diabetes), WBC (infection/UTI), RBC (bleeding). Used to detect/monitor kidney issues, UTI, diabetes, liver disease, hydration status.

CHOLESTEROL & INFLAMMATION:
Total Cholesterol: Normal <200 mg/dL. High = increased CVD risk.
LDL ("bad" cholesterol): Normal <100 mg/dL. Deposits plaque on vessel walls → atherosclerosis/CAD risk.
HDL ("good" cholesterol): Normal >60 mg/dL. HIGHER IS BETTER. Removes LDL from blood — protective against CVD.
CRP (C-reactive protein): Normal <10 mg/L. Elevation indicates inflammatory illness; may predict coronary events.

COAGULATION:
PT/INR: Normal PT 11-12.5 sec, INR 0.8-1.1. Monitors warfarin therapy. Therapeutic INR for warfarin = 2-3. Antidote = Vitamin K.
PTT: Normal 60-70 sec. Monitors heparin therapy. Therapeutic = 1.5-2x normal. Antidote = protamine sulfate.
aPTT: Normal 30-40 sec. Same as PTT but with activator added. Also monitors heparin.

CARDIAC INJURY MARKERS:
Troponin (MOST SPECIFIC for MI): Normal <0.1 ng/mL. Rises 2-3 hours post-MI. Stays elevated 1-2 WEEKS. Draw FIRST for suspected MI.
CK-MB: Normal 55-170 U/L. Rises 3-6 hours post-MI. Clears in 1-2 days. Best for detecting RE-INFARCTION because it clears quickly.
BNP: Normal <100 pg/mL. Released when left ventricle is overstretched from fluid buildup. Elevated = left heart failure. Higher BNP = more severe CHF.

DIAGNOSTIC TESTS:
EKG/ECG: records electrical impulses that stimulate the heart to contract. P wave = atrial contraction; QRS = ventricular contraction; T wave = repolarization.
Echocardiogram: ultrasound of the heart; evaluates structure, function, valves, blood flow. Normal EF 50-75%. EF <40% = systolic heart failure.
ABGs: arterial blood gases; pH 7.35-7.45, PaCO2 35-45, PaO2 80-100, HCO3- 22-26. Collected from artery; keep on ice; apply 5 min pressure after draw.
Pulse Oximetry (SpO2): normal 95-100%; COPD target 88-92%. Inaccurate with nail polish, poor perfusion, CO poisoning, severe anemia.
PFTs (Pulmonary Function Tests): measure lung volumes and capacities; emphysema shows increased residual volume.
CXR/CT: detects pneumonia, atelectasis, pleural effusion, pneumothorax, COPD changes, cardiomegaly.`,
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
  /* flashcards with this exact objective_id in their objective_ids array */
  const data = await sbGet(
    `/flashcards?select=question,answer&objective_ids=cs.%7B${objId}%7D&course=eq.NUR118&limit=200`
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
For list cards (e.g. 8 signs of distress), test individual items.
For drug cards, test each specific nursing action and monitoring parameter separately.
For value cards (normal ranges), test what the abnormal value means clinically, not just the number.
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
  "stem":"A nurse is caring for a 68-year-old client with COPD who...",
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
  // Step 1: strip markdown code fences
  const stripped = text
    .replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/```\s*$/m, '').trim();

  // Step 2: fix unescaped control characters inside string values.
  // Gemini 2.5-flash often embeds real newlines/tabs inside JSON strings.
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
        else if (c === '\r') out += '';       // drop bare CR
        else if (c === '\t') out += '\\t';
        else                 out += c;
      } else {
        out += c;
      }
    }
    return out;
  }

  // Step 3: truncation recovery — find the last complete question object
  // and close the array/root properly (handles max-token cutoff mid-JSON).
  function truncationRecover(s) {
    // Walk to find end-positions of top-level array elements (depth-2 objects)
    let depth = 0;
    let inStr2 = false;
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
    const lastEnd = questionEnds[questionEnds.length - 1];
    const rebuilt = s.slice(0, lastEnd + 1) + ']}';
    try { return JSON.parse(rebuilt); } catch { return null; }
  }

  const clean = sanitize(stripped);

  let parsed = null;

  // Attempt 1: direct parse of sanitized text
  try { parsed = JSON.parse(clean); } catch { /* fall through */ }

  // Attempt 2: extract JSON object anywhere in the text (handles leading/trailing prose)
  if (!parsed) {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch { /* fall through */ }
  }

  // Attempt 3: truncation recovery on sanitized text
  if (!parsed) parsed = truncationRecover(clean);

  // Attempt 4: truncation recovery on raw stripped text (pre-sanitize)
  if (!parsed) parsed = truncationRecover(stripped);

  // Attempt 5: bare array [ {...}, {...} ] — wrap in {"questions": ...}
  if (!parsed) {
    const trimmed = clean.trimStart();
    if (trimmed.startsWith('[')) {
      try { parsed = { questions: JSON.parse(trimmed) }; } catch { /* fall through */ }
    }
  }

  // Attempt 6: object missing outer braces — starts with "questions":
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
    // Always use the fallback objective_id if Gemini returned a wrong/missing one
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

/* ── Sleep helper ────────────────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Main ────────────────────────────────────────────────────────────────────── */
async function main() {
  console.log('\n════════════════════════════════════════════════');
  console.log('  NurseStudy — Bulk Question Bank Generator');
  console.log('════════════════════════════════════════════════\n');

  const existing = await getExistingCounts();
  console.log(`Existing questions in bank: ${Object.values(existing).reduce((a,b)=>a+b,0)}`);

  // Skip if already have ≥8 questions; re-run anything below that threshold
  const MIN_QUESTIONS = 8;
  const toGenerate = OBJECTIVES.filter(id => !(existing[id] >= MIN_QUESTIONS));
  const toSkip     = OBJECTIVES.filter(id =>  (existing[id] >= MIN_QUESTIONS));

  if (toSkip.length) {
    console.log(`\nSkipping ${toSkip.length} objectives (already have questions):`);
    toSkip.forEach(id => console.log(`  ✓ ${id} (${existing[id]} questions)`));
  }

  if (!toGenerate.length) {
    console.log('\nAll objectives already have questions! Run the summary SQL to verify totals.');
    await printFinalCount();
    return;
  }

  console.log(`\nGenerating for ${toGenerate.length} objectives...\n`);

  let totalNew = 0;
  let errors = [];

  for (let i = 0; i < toGenerate.length; i++) {
    const objId = toGenerate[i];
    const objName = OBJECTIVE_NAMES[objId] || objId;
    const sectionKey = SECTION_FOR_OBJ[objId] || 'resp';
    const guideText = STUDY_GUIDE[sectionKey] || '';

    process.stdout.write(`[${i+1}/${toGenerate.length}] ${objId} — ${objName.slice(0,50)}... `);

    try {
      const allCards = await getFlashcards(objId);
      if (!allCards.length) {
        console.log(`SKIPPED (no flashcards found)`);
        continue;
      }
      // Cap at 20 cards per call — large card sets overflow the token budget
      // and cause truncated responses.  Re-runs will pick a different slice
      // if needed (Gemini's sampling varies with temperature).
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
      console.log(`ERROR: ${err.message}`);
      errors.push({ objId, error: err.message });
    }

    // Rate limit delay between calls (5s to reduce 503s)
    if (i < toGenerate.length - 1) await sleep(5000);
  }

  console.log('\n════════════════════════════════════════════════');
  console.log(`  Generation complete! ${totalNew} new questions saved.`);
  if (errors.length) {
    console.log(`\n  ${errors.length} objective(s) failed:`);
    errors.forEach(e => console.log(`    ✗ ${e.objId}: ${e.error.slice(0,80)}`));
    console.log('\n  Re-run the script to retry failed objectives (it will skip completed ones).');
  }
  console.log('════════════════════════════════════════════════\n');

  await printFinalCount();
}

async function printFinalCount() {
  try {
    const data = await sbGet('/quiz_questions?select=objective_id&is_targeted=eq.false&limit=10000');
    const counts = {};
    for (const r of data) counts[r.objective_id] = (counts[r.objective_id] || 0) + 1;
    const total = Object.values(counts).reduce((a,b)=>a+b,0);
    const objCount = Object.keys(counts).length;
    console.log(`\nFinal question bank: ${total} questions across ${objCount} objectives`);
    console.log('\nBreakdown:');
    for (const id of OBJECTIVES) {
      const n = counts[id] || 0;
      const bar = '█'.repeat(Math.min(Math.floor(n/5), 30));
      console.log(`  ${id.padEnd(12)} ${String(n).padStart(4)} ${bar}`);
    }
  } catch (e) {
    console.warn('Could not fetch final count:', e.message);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
