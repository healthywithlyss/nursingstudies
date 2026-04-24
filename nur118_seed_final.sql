-- NUR 118 Unit 2 Final Audited Seed -- 271 cards, 49 objectives

CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  lecture TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS flashcards (
  id BIGSERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  objective_ids TEXT[] NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS card_attempts (
  id BIGSERIAL PRIMARY KEY,
  card_id BIGINT REFERENCES flashcards(id),
  result TEXT NOT NULL CHECK (result IN ('got_it','unsure','missed')),
  session_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE objectives ENABLE ROW LEVEL SECURITY;
ALTER TABLE flashcards ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON objectives FOR ALL USING (true);
CREATE POLICY "allow all" ON flashcards FOR ALL USING (true);
CREATE POLICY "allow all" ON card_attempts FOR ALL USING (true);

INSERT INTO objectives (id, lecture, description) VALUES
  ('L78_01', 'Lec 7&8', 'Identify structures of the upper and lower airway'),
  ('L78_02', 'Lec 7&8', 'Distinguish between external and internal respiration'),
  ('L78_03', 'Lec 7&8', 'Respiratory assessment — inspection: 6 characteristics'),
  ('L78_04', 'Lec 7&8', 'Identify 9 breathing patterns'),
  ('L78_05', 'Lec 7&8', 'Identify 8 signs of respiratory distress/effort'),
  ('L78_06', 'Lec 7&8', 'Palpation — pain, masses, respiratory excursion'),
  ('L78_07', 'Lec 7&8', 'Auscultation — technique, normal and abnormal lung sounds'),
  ('L78_08', 'Lec 7&8', 'List signs and symptoms of hypoxia (early and late)'),
  ('L78_09', 'Lec 7&8', 'Describe COPD: chronic bronchitis vs. emphysema'),
  ('L78_10', 'Lec 7&8', 'Describe obstructive sleep apnea S&S and treatment'),
  ('L78_11', 'Lec 7&8', 'Differentiate normal stimulus to breathe vs. hypoxic drive'),
  ('L78_12', 'Lec 7&8', 'Identify situations for applying supplemental O2 and devices'),
  ('L78_13', 'Lec 7&8', 'When to suction — Yankauer vs. suction catheter'),
  ('L78_14', 'Lec 7&8', 'Nursing interventions for gaseous transfer'),
  ('L78_15', 'Lec 7&8', 'Medications: codeine and guaifenesin'),
  ('L78_16', 'Lec 7&8', 'List labs and diagnostics related to gaseous transfer'),
  ('L910_01', 'Lec 9&10', 'ANS function in CV: sympathetic vs. parasympathetic'),
  ('L910_02', 'Lec 9&10', 'Cardiovascular assessment — inspection, palpation, auscultation'),
  ('L910_03', 'Lec 9&10', 'Laboratory studies and diagnostics r/t cardiovascular assessment'),
  ('L910_04', 'Lec 9&10', 'Heart Failure — Right and Left: etiology and signs and symptoms'),
  ('L910_05', 'Lec 9&10', 'PVD: 5 P''''s and a T — PAD vs. PVD S&S and nursing interventions'),
  ('L910_06', 'Lec 9&10', 'Nursing interventions and patient teaching for CV conditions'),
  ('L910_07', 'Lec 9&10', 'Unit 2 Medications — cardiovascular drugs'),
  ('L11A_01', 'Lec 11 ABG', 'List 3 ways the body maintains acid-base balance'),
  ('L11A_02', 'Lec 11 ABG', 'Know normal values of pH, PaCO2, HCO3'),
  ('L11A_03', 'Lec 11 ABG', 'Analyze ABGs for respiratory acidosis and alkalosis'),
  ('L11A_04', 'Lec 11 ABG', 'Analyze ABGs for metabolic acidosis and alkalosis'),
  ('L11F_01', 'Lec 11 Fluids', 'Distinguish between intracellular, extracellular, and transcellular fluid'),
  ('L11F_02', 'Lec 11 Fluids', 'Explain osmosis, diffusion, filtration, active transport'),
  ('L11F_03', 'Lec 11 Fluids', 'List 10 signs and symptoms of need for fluids'),
  ('L11F_04', 'Lec 11 Fluids', 'Explain role of ADH in regulation of fluid balance'),
  ('L11F_05', 'Lec 11 Fluids', 'Describe hypovolemia and hypervolemia — S&S and nursing interventions'),
  ('L11F_06', 'Lec 11 Fluids', 'Nursing interventions for increasing and restricting fluid intake'),
  ('L11F_07', 'Lec 11 Fluids', 'Distinguish between isotonic, hypotonic, and hypertonic IV solutions'),
  ('L11F_08', 'Lec 11 Fluids', 'Know normal values and S&S of electrolyte imbalances: Na, K, Ca, Mg'),
  ('L12I_01', 'Lec 12 IV', 'Define peripheral IV therapy and list complications and nursing interventions'),
  ('L12I_02', 'Lec 12 IV', 'List types of central IV therapy'),
  ('L12I_03', 'Lec 12 IV', 'List indications for transfusion of blood products'),
  ('L12I_04', 'Lec 12 IV', 'State time limitations for a blood transfusion'),
  ('L12I_05', 'Lec 12 IV', 'Describe 5 types of blood transfusion reactions and nursing interventions'),
  ('L12M_01', 'Lec 12 Mgmt', 'List causes of escalating costs of healthcare'),
  ('L12M_02', 'Lec 12 Mgmt', 'Discuss ways nurses can contribute to cost containment'),
  ('MED_01', 'Unit 2 Meds', 'Medications: cardiovascular drugs'),
  ('MED_02', 'Unit 2 Meds', 'Medications: anticoagulants'),
  ('MED_03', 'Unit 2 Meds', 'Medications: diuretics and electrolyte supplements'),
  ('MED_04', 'Unit 2 Meds', 'Medications: respiratory drugs'),
  ('MED_05', 'Unit 2 Meds', 'Medications: endocrine and GI drugs'),
  ('LAB_01', 'Labs 116/118', 'Know normal ranges for all highlighted lab values'),
  ('LAB_02', 'Labs 116/118', 'Know significance of high and low values for all highlighted labs');

INSERT INTO flashcards (question, answer, objective_ids) VALUES
  ('Upper vs lower airway — structures, boundary, and sterility', 'Upper (above larynx): nasal passages, mouth, pharynx — NOT sterile
Lower (below larynx): trachea, bronchi, bronchioles — STERILE
Suctioning below the larynx = sterile technique required', '{L78_01}'),
  ('Where does gas exchange occur?', 'At the alveoli', '{L78_01}'),
  ('Ventilation vs respiration vs oxygenation — define each', 'Ventilation: moving air in and out of the lungs
Respiration: exchange of O2 and CO2
Oxygenation: O2 actually reaching cells, tissues, and organs', '{L78_02}'),
  ('External vs internal respiration — where and what happens', 'External: at the alveoli — O2 enters blood, CO2 exits to be exhaled
Internal: at the tissues — O2 leaves blood into cells, CO2 from cells enters blood', '{L78_02}'),
  ('Can you assess gas exchange by counting respiratory rate?', 'No — RR tells you about ventilation only, not whether gas exchange is occurring', '{L78_02}'),
  ('What are the 6 characteristics assessed on respiratory inspection?', '1. Skin/mucous membrane color
2. Cough and sputum (COCAF)
3. RR, rhythm, depth, pattern, effort
4. Symmetry of chest movement
5. AP diameter/chest shape
6. Spinal deformities and edema', '{L78_03}'),
  ('COCAF — what does each letter stand for?', 'Color, Odor, Consistency, Amount, Frequency', '{L78_03}'),
  ('Sputum color: white/clear, yellow-green, pink frothy, rust, black', 'White/clear = viral
Yellow-green = bacterial
Pink frothy = pulmonary edema
Rust = TB
Black = smoke inhalation', '{L78_03}'),
  ('Normal AP:Lateral ratio vs barrel chest — ratio and cause', 'Normal = 1:2
Barrel chest = 1:1 — chronic air trapping in COPD/emphysema', '{L78_03}'),
  ('What does asymmetric chest movement on inspection indicate?', 'Problem on one side — pneumothorax, effusion, obstruction, or splinting from pain', '{L78_03}'),
  ('Eupnea — definition', 'Normal breathing — 12–20 bpm, regular rhythm and depth', '{L78_04}'),
  ('Tachypnea — rate and causes', '>24 bpm, fast and shallow
Causes: pneumonia, pulmonary edema, metabolic acidosis, sepsis, pain, fever', '{L78_04}'),
  ('Bradypnea — rate and causes', '<10 bpm, slow
Causes: head injury, opioid OD, PaCO2 >45, neurological damage', '{L78_04}'),
  ('Apnea — definition and causes', 'Complete absence of breathing
Causes: respiratory arrest, OSA episodes', '{L78_04}'),
  ('Kussmaul''s — description and cause', 'Fast AND deep breathing
Cause: metabolic acidosis (DKA) — lungs blowing off CO2 to compensate', '{L78_04}'),
  ('Cheyne-Stokes vs Biot''s — pattern and cause for each', 'Cheyne-Stokes: regular cycle of increasing → decreasing depth → apnea → repeats. Cause: brain damage, end-stage HF
Biot''s: completely irregular bursts, no cycle. Cause: increased ICP, brain injury', '{L78_04}'),
  ('Orthopnea — definition and cause', 'SOB when lying flat — patient must sit upright
Cause: left HF — fluid shifts to lungs when supine', '{L78_04}'),
  ('Stridor — description, phase, causes, and why it is an emergency', 'Harsh crowing sound on INSPIRATION — audible without stethoscope
Causes: anaphylaxis, croup, epiglottitis, foreign body
EMERGENCY — partial upper airway obstruction can progress to complete blockage', '{L78_04,L78_05}'),
  ('List the 8 signs of respiratory distress', '1. Nasal flaring
2. Retractions
3. Accessory muscle use
4. Grunting
5. Orthopnea
6. Conversational dyspnea
7. Wheezing (expiratory)
8. Stridor (inspiratory — EMERGENCY)', '{L78_05}'),
  ('Wheezing vs stridor — phase and what each indicates', 'Wheezing: expiratory — narrowed lower airways
Stridor: inspiratory — upper airway obstruction — EMERGENCY', '{L78_05}'),
  ('What is grunting in respiratory distress?', 'Forced exhalation against a partially closed glottis — creates back-pressure to keep alveoli open', '{L78_05}'),
  ('What are retractions?', 'Skin visibly pulling inward between or below the ribs on inhalation — patient working hard to pull air in', '{L78_05}'),
  ('Respiratory excursion — how to assess and normal finding', 'Thumbs at T10, patient takes deep breath — both sides should expand equally
Asymmetry = pleurisy, fractured ribs, or splinting', '{L78_06}'),
  ('Percussion sounds — what each indicates', 'Resonance = normal lung
Dullness = fluid or consolidation (pneumonia, effusion)
Hyperresonance = trapped air (emphysema, pneumothorax)
Flatness = solid tissue or bone', '{L78_06}'),
  ('Auscultation technique', 'Instruct: slow deep breaths through open mouth
Diaphragm of stethoscope, between ribs (never over bone), compare side to side', '{L78_07}'),
  ('Normal lung sounds — 3 types and where each is heard', 'Bronchial → over trachea
Broncho-vesicular → over sternum anteriorly, between scapulae posteriorly
Vesicular → over lower lung fields', '{L78_07}'),
  ('Crackles (rales) — phase, mechanism, causes, can they clear?', 'Phase: inspiration
Mechanism: air bubbling through fluid in alveoli
Causes: CHF, pneumonia, pulmonary edema, atelectasis
Cannot be cleared by coughing', '{L78_07}'),
  ('Rhonchi — phase, mechanism, causes, can they clear?', 'Phase: expiration
Mechanism: air through secretions in bronchi
Causes: COPD, bronchitis
May clear with coughing', '{L78_07}'),
  ('Wheezes — phase, mechanism, causes', 'Phase: expiration
Mechanism: air through narrowed airways
Causes: asthma, bronchospasm', '{L78_07}'),
  ('Pleural friction rub — phase, mechanism, cause', 'Phase: both inspiration and expiration
Mechanism: inflamed pleural layers rubbing
Cause: pleuritis — grating/leathery sound', '{L78_07}'),
  ('Hypoxemia vs hypoxia — define each and which comes first', 'Hypoxemia: low O2 in the BLOOD (PaO2 <80 mmHg)
Hypoxia: low O2 in the TISSUES (SpO2 <90%)
Hypoxemia comes first → leads to hypoxia if untreated', '{L78_08}'),
  ('What is the FIRST sign of hypoxia?', 'Restlessness', '{L78_08}'),
  ('Early signs of hypoxia', 'Restlessness (first!), anxiety, confusion, tachycardia, tachypnea, hypertension, nasal flaring, accessory muscle use, pale skin', '{L78_08}'),
  ('Late signs of hypoxia', 'Bradycardia, bradypnea, severe dyspnea, decreased LOC/coma, hypotension, cyanosis of tongue and oral mucosa, clubbing (chronic)', '{L78_08}'),
  ('Best physical indicator of hypoxia?', 'Cyanosis of the tongue and oral mucosa — central cyanosis is more reliable than peripheral', '{L78_08}'),
  ('Why does tachycardia progress to bradycardia in late hypoxia?', 'Tachycardia = early compensation
Bradycardia = heart failing from prolonged O2 deprivation — dangerous late sign', '{L78_08}'),
  ('Blue Bloater vs Pink Puffer — nickname meaning and core problem', 'Blue Bloater (chronic bronchitis): cyanotic, overweight — O2 can''t get IN (mucus blocks airways)
Pink Puffer (emphysema): pink skin, thin — CO2 can''t get OUT (destroyed alveoli trap air)', '{L78_09}'),
  ('Chronic bronchitis — key S&S', 'Chronic productive cough, thick tenacious sputum, rhonchi, wheezing, hypoxemia/cyanosis, tachycardia, tachypnea, peripheral edema, orthopnea', '{L78_09}'),
  ('Emphysema — key S&S', 'Barrel chest, pursed-lip breathing, difficulty exhaling, grunting, weight loss, tripod positioning, clubbing, accessory muscle use', '{L78_09}'),
  ('COPD — #1 cause and diagnostic tests', '#1 cause: smoking (90%)
Diagnostics: PFTs, CXR, ABGs', '{L78_09}'),
  ('COPD treatment', 'Bronchodilators, corticosteroids, expectorants, controlled O2/BiPAP, smoking cessation, pulmonary rehab, vaccinations
Emphysema adds: pursed-lip breathing (critical)', '{L78_09}'),
  ('What does emphysema show on PFTs and why?', 'Increased residual volume — destroyed alveoli cannot recoil so air gets trapped and cannot be fully exhaled', '{L78_09}'),
  ('OSA — signs and symptoms', 'Snoring/gasping during sleep, apnea episodes 10–120 sec, unrefreshing sleep, daytime sleepiness, morning headache (CO2 retained), dry mouth in AM', '{L78_10}'),
  ('OSA — risk factors', 'Age >40, male, overweight, neck >17" (M) or >16" (F), alcohol before sleep, smoking, sleep-inducing meds, large tonsils or small mandible', '{L78_10}'),
  ('OSA — treatment', 'First-line: CPAP
Also: BiPAP, side-lying sleep, weight loss ≥10%, no alcohol, dental appliances', '{L78_10}'),
  ('Why are opioids and sedatives dangerous in OSA?', 'Suppress respiratory drive — already compromised in OSA — risk of fatal respiratory depression', '{L78_10}'),
  ('Normal stimulus to breathe vs hypoxic drive', 'Normal: HIGH CO2 (elevated PaCO2) is the primary stimulus
COPD/hypoxic drive: chronically elevated CO2 desensitizes the body — LOW O2 becomes the ONLY stimulus', '{L78_11}'),
  ('Why is too much O2 dangerous for a COPD patient with hypoxic drive?', 'Removes their only stimulus to breathe → patient stops breathing → can be fatal', '{L78_11}'),
  ('Target SpO2 for COPD patients and why', '88–92% — enough to oxygenate without eliminating the hypoxic drive', '{L78_11}'),
  ('When should supplemental O2 be applied?', 'SpO2 <90% with symptoms — restlessness, confusion, cyanosis, MI
O2 = medication, requires order
Exception: RN may give 2L NC in emergency, get order after', '{L78_12}'),
  ('Nasal cannula — flow rate, FiO2, key points', 'Flow: 1–6 L/min | FiO2: 20–40%
Prongs curve downward
Humidify if >3 L/min
RN can give 2L in emergency without order', '{L78_12}'),
  ('Simple face mask — flow rate, FiO2, minimum rate', 'Flow: 6–10 L/min | FiO2: 40–60%
Minimum 6 L/min — below this CO2 rebreathes in dead space', '{L78_12}'),
  ('Partial non-rebreather mask — flow rate, FiO2, key monitoring', 'Flow: 8–11 L/min | FiO2: 60–75%
Reservoir bag must stay PARTIALLY inflated at all times', '{L78_12}'),
  ('Non-rebreather (NRB) — flow rate, FiO2, time limit', 'Flow: 10–15 L/min | FiO2: 80–100%
Max 1–1.5 hours — if fails → intubation', '{L78_12}'),
  ('Venturi mask — why used for COPD and FiO2 values', 'Most precise delivery — preferred for COPD
2L=24%, 4L=28%, 6L=31%, 8L=35%, 10L=40%, 15L=60%
Target SpO2 88–92%', '{L78_12}'),
  ('Face tent — when is it used?', 'Claustrophobic patients who need humidified O2 and cannot tolerate a mask', '{L78_12}'),
  ('Yankauer vs suction catheter — use, sterility, location', 'Yankauer: mouth/upper pharynx, NOT sterile, for visible/gurgling upper airway secretions
Suction catheter: lower airway, STERILE, requires sterile technique', '{L78_13}'),
  ('Deep suctioning — procedure rules', 'Pre-oxygenate with 100% O2
Suction on withdrawal ONLY
Max 10 seconds per pass
Max 3 passes, allow recovery between each', '{L78_13}'),
  ('Complications of deep suctioning', 'Mucosal trauma, hypoxia, bronchospasm, atelectasis, dysrhythmias', '{L78_13}'),
  ('Why is High Fowler''s used for respiratory patients?', 'Gravity pulls abdominal organs down — diaphragm descends fully — maximizes lung expansion', '{L78_14}'),
  ('Incentive spirometer — purpose, technique, frequency', 'Purpose: prevent/reverse atelectasis
Technique: slow deep inhale → hold 3–5 sec → exhale
Frequency: 10–20 times per hour', '{L78_14}'),
  ('Pursed-lip breathing — purpose and who needs it', 'Slows exhalation, keeps airways open, releases trapped CO2
Critical for emphysema patients', '{L78_14}'),
  ('Peak flow meter — 3 zones and what each means', 'Green (80–100%): all clear
Yellow (50–80%): take bronchodilator
Red (<50%): go to ED', '{L78_14}'),
  ('How does hydration help respiratory patients?', 'Thins secretions — easier to mobilize and expectorate', '{L78_14}'),
  ('Codeine vs guaifenesin — classification and action', 'Codeine: antitussive opioid — SUPPRESSES cough reflex in medulla
Guaifenesin: expectorant — thins mucus, PROMOTES productive cough', '{L78_15,MED_04}'),
  ('Codeine — what to monitor and side effects', 'Monitor: RR and sedation level
Side effects: sedation, constipation, hypotension
Caution in COPD/OSA — suppresses respiratory drive', '{L78_15,MED_04}'),
  ('Guaifenesin — what is essential for it to work?', 'Adequate fluid intake — water thins and liquefies secretions', '{L78_15,MED_04}'),
  ('SpO2 — normal range, COPD target, causes of inaccuracy', 'Normal: 95–100% | COPD target: 88–92%
Inaccurate with: nail polish, poor perfusion, CO poisoning, severe anemia', '{L78_16,LAB_01}'),
  ('ABG normal values', 'pH: 7.35–7.45
PaCO2: 35–45 mmHg
HCO3−: 22–26 mEq/L
PaO2: 80–100 mmHg', '{L78_16,L11A_02,LAB_01}'),
  ('PPD — when to read and what is positive', 'Read at 48–72 hours
Positive = redness AND induration — redness alone is NOT positive', '{L78_16}'),
  ('PFTs — what they measure and key finding in emphysema', 'Measure lung volumes and capacities
Emphysema: increased residual volume — air cannot be fully exhaled', '{L78_16}'),
  ('Sputum C&S — when to collect and how', 'Morning before breakfast
Deep cough into a sterile container', '{L78_16}'),
  ('CXR — what respiratory conditions does it detect?', 'Pneumonia, atelectasis, pleural effusion, pneumothorax, COPD changes', '{L78_16}'),
  ('Circulation vs perfusion — define each', 'Circulation: blood flowing through heart and vessels
Perfusion: O2 reaching the capillary beds and tissues', '{L910_01}'),
  ('Ischemia vs infarction — define each', 'Ischemia: tissue alive but O2-deprived — REVERSIBLE if treated
Infarction: tissue DEAD — IRREVERSIBLE (prolonged ischemia leads to MI)', '{L910_01}'),
  ('Cardiac conduction pathway in order', 'SA Node → AV Node → Bundle of His → L&R Bundle Branches → Purkinje Fibers → ventricles contract
SA Node = primary pacemaker (60–100 bpm)
If SA fails → AV takes over
If both fail → Purkinje fires at <40 bpm', '{L910_01}'),
  ('Sympathetic vs parasympathetic — effect on HR, contractility, vessels', 'Sympathetic: ↑ HR, ↑ contractility, controls ALL blood vessels (fight or flight)
Parasympathetic: ↓ HR only via vagus nerve, NO effect on contractility, NO vessel control (rest and digest)', '{L910_01}'),
  ('What neurotransmitters does the sympathetic system use?', 'Epinephrine and norepinephrine — act on beta receptors
Atenolol (beta blocker) blocks these receptors → ↓ HR and ↓ BP', '{L910_01}'),
  ('What neurotransmitter does the parasympathetic system use?', 'Acetylcholine', '{L910_01}'),
  ('Blood flow through the heart in order', 'Body → Vena Cava → R. Atrium → Tricuspid → R. Ventricle → Pulmonic → Lungs → Pulm. Vein → L. Atrium → Mitral → L. Ventricle → Aortic → Body
Atria RECEIVE, Ventricles PUMP, Valves prevent backflow', '{L910_01}'),
  ('CV inspection — what do you assess?', 'Signs of distress, skin color, breathing effort
JVD (assessed at 15–45°) — indicates right HF or fluid overload
Edema, clubbing, precordium (size, shape, apical impulse)', '{L910_02}'),
  ('Pulse quality grading scale', '0 = absent
1+ = weak/thready
2+ = normal
3+ = bounding', '{L910_02}'),
  ('Pitting edema grading scale', '1+ = 2 mm
2+ = 4 mm
3+ = 6 mm
4+ = 8 mm', '{L910_02}'),
  ('S1 vs S2 — which valves close and when', 'S1 (LUB): AV valves CLOSE = start of systole (mitral + tricuspid)
S2 (DUB): semilunar valves CLOSE = end of systole (aortic + pulmonic)', '{L910_02}'),
  ('Valve auscultation sites — APETM', 'A (Aortic): 2nd RIGHT ICS
P (Pulmonic): 2nd LEFT ICS
E (Erb''s point): 3rd LEFT ICS
T (Tricuspid): 4th LEFT ICS
M (Mitral): 5th ICS left midclavicular line', '{L910_02}'),
  ('EKG waves — P, QRS, T — what each represents', 'P wave: atrial depolarization → atria contract
QRS: ventricular depolarization → ventricles contract
T wave: ventricular repolarization → ventricles relax
Flat T = hypokalemia | Tall T = hyperkalemia | Absent P = A-fib', '{L910_01,L910_02}'),
  ('Troponin — normal value, when it rises, how long it stays elevated', 'Normal: <0.1 ng/mL
Rises: 2–3 hours post-MI
Stays elevated: 1–2 weeks
Most specific marker for MI — draw FIRST for suspected MI', '{L910_03,LAB_01,LAB_02}'),
  ('CK-MB — normal value, timing, best use', 'Normal: 55–170 U/L
Rises: 3–6 hours post-MI
Clears: 1–2 days
Best for detecting RE-INFARCTION (clears fast so a new rise = new event)', '{L910_03,LAB_01,LAB_02}'),
  ('BNP — normal value and what elevation indicates', 'Normal: <100 pg/mL
Elevated = LV is stretched from fluid buildup = LEFT heart failure
Higher BNP = more severe CHF', '{L910_03,LAB_01,LAB_02}'),
  ('Echocardiogram — what it evaluates and normal EF', 'Ultrasound of the heart — evaluates structure, function, valves, and blood flow
Normal ejection fraction (EF): 50–75%
EF <40% = systolic heart failure', '{L910_03,LAB_01,LAB_02}'),
  ('PT/INR vs PTT/aPTT — what each monitors', 'PT/INR: monitors warfarin | therapeutic INR = 2–3
PTT/aPTT: monitors heparin | therapeutic = 1.5–2× normal', '{L910_03,LAB_01,LAB_02}'),
  ('Left HF vs right HF — etiology for each', 'Left HF: LV can''t pump → backs up into LUNGS → pulmonary congestion
Right HF: RV can''t pump → backs up into PERIPHERAL VEINS → systemic congestion (often caused by left HF)', '{L910_04}'),
  ('Left HF — signs and symptoms', 'SOB/dyspnea, orthopnea, CRACKLES, wheezing, pink frothy sputum, tachypnea, tachycardia, confusion, fatigue, exercise intolerance', '{L910_04}'),
  ('Right HF — signs and symptoms', 'Peripheral edema, JVD, ascites, weight gain, enlarged liver/spleen, fatigue, weakness
Memory: Right = Rings (rings don''t fit from edema)', '{L910_04}'),
  ('Left HF vs right HF — which causes crackles and which causes peripheral edema?', 'Left HF: CRACKLES (fluid backs into lungs)
Right HF: PERIPHERAL EDEMA and JVD (fluid backs into body)', '{L910_04}'),
  ('5 P''s and a T for peripheral vascular assessment', 'Pain, Pallor, Pulse, Paresthesia, Paralysis, Temperature', '{L910_05}'),
  ('PAD vs PVD — core problem and key signs for each', 'PAD (arterial): plaque narrows arteries → not enough blood to legs
Signs: pale/cool, weak/absent pulses, no leg hair, thick toenails, toe wounds, intermittent claudication
PVD (venous): incompetent valves → blood pools in legs
Signs: brownish-red discoloration, varicose veins, pitting edema, stasis ulcers on lower leg', '{L910_05}'),
  ('PAD vs PVD — leg position and why', 'PAD: legs DOWN — gravity assists arterial flow to feet
PVD: legs UP — gravity drains venous blood back to heart', '{L910_05}'),
  ('What is intermittent claudication?', 'Leg pain that occurs with walking and is relieved by rest — caused by arterial insufficiency (PAD)', '{L910_05}'),
  ('CV nursing interventions', 'Monitor VS, I&O, daily weights, edema
O2 as ordered, HOB elevated
DASH diet (↓ sodium, ↓ fat)
Manage anxiety (SNS activation increases cardiac workload)
Cluster care, activity as tolerated', '{L910_06}'),
  ('CV patient teaching', 'Daily weight — report gain >2 lb/day or >5 lb/week
Low-sodium diet, no smoking, medication compliance
PAD: daily foot care, no restrictive clothing
PVD: compression stockings, ankle circles, no crossing legs', '{L910_06}'),
  ('Atenolol — classification, action, use, nursing', 'Classification: beta-blocker
Action: blocks NE/epi at beta receptors → ↓ HR, ↓ cardiac workload
Use: HTN, angina, MI prevention
Nursing: monitor BP, EKG, and pulse | rise slowly (orthostatic hypotension)', '{L910_07,MED_01}'),
  ('Enalapril — classification, key SE, nursing', 'Classification: ACE inhibitor — antihypertensive
Action: blocks angiotensin II → vasodilation → ↓ BP
Key SE: DRY COUGH (bradykinin buildup)
Nursing: monitor BP, BUN, creatinine, electrolytes', '{L910_07,MED_01}'),
  ('Nitroglycerin — classification, action, nursing', 'Classification: vasodilator (nitrate)
Action: dilates coronary arteries → ↑ blood flow to ischemic heart, ↓ BP
Nursing: check BP before AND after | patient must SIT before giving | common SE: headache | rise slowly', '{L910_07,MED_01}'),
  ('Digoxin — classification, action, when to hold, therapeutic level', 'Classification: cardiac glycoside — positive inotrope
Action: ↑ force of contraction, ↓ HR — used for HF and A-fib
Hold if apical pulse <60 (check 1 full minute)
Therapeutic level: 0.5–2 mg/mL', '{L910_07,MED_01}'),
  ('Digoxin toxicity — what causes it and signs', 'Caused by: low K+ or low Mg2+ (most common), elevated digoxin level
Signs: abdominal pain, anorexia, N/V, YELLOW/GREEN HALOS (visual), bradycardia', '{L910_07,MED_01}'),
  ('Atorvastatin — classification, action, key nursing concern', 'Classification: statin — lipid-lowering agent
Action: ↓ LDL synthesis → ↓ plaque formation
Nursing: monitor liver enzymes and lipid panel
Muscle pain → check CK immediately — rhabdomyolysis risk', '{L910_07,MED_01}'),
  ('3 ways the body maintains acid-base balance — name and speed of each', '1. Buffers — fastest, act instantly, no organ required
2. Lungs — control CO2, respond in minutes
3. Kidneys — control HCO3−, respond in days (slowest)', '{L11A_01}'),
  ('How do the lungs compensate for acid-base imbalance?', 'Too acidic → breathe FASTER → blow off CO2 (lungs compensate for metabolic acidosis)
Too alkaline → breathe SLOWER → retain CO2 (lungs compensate for metabolic alkalosis)', '{L11A_01}'),
  ('How do the kidneys compensate for acid-base imbalance?', 'Too acidic → RETAIN HCO3−, excrete H+ in urine (kidneys compensate for respiratory acidosis)
Too alkaline → EXCRETE HCO3− (kidneys compensate for respiratory alkalosis)', '{L11A_01}'),
  ('Normal ABG values', 'pH: 7.35–7.45
PaCO2: 35–45 mmHg (respiratory — CO2 is an ACID)
HCO3−: 22–26 mEq/L (metabolic — HCO3− is a BASE)
PaO2: 80–100 mmHg', '{L11A_02}'),
  ('ABG tic-tac-toe method — 3 steps', 'Step 1: Is pH acid (<7.35), normal, or base (>7.45)?
Step 2: Is PaCO2 acid (>45), normal, or base (<35)?
Step 3: Is HCO3− acid (<22), normal, or base (>26)?
Whichever matches pH direction = the CAUSE
CO2 matches → Respiratory | HCO3− matches → Metabolic', '{L11A_02}'),
  ('ROME mnemonic for ABGs', 'Respiratory = Opposite (CO2 moves opposite to pH)
Metabolic = Equal (HCO3− moves same direction as pH)', '{L11A_02}'),
  ('Respiratory acidosis — pH, PaCO2, causes, S&S, TX', 'pH ↓ | PaCO2 ↑
Causes: COPD, opioid OD, apnea, airway obstruction, CHF, pneumonia
S&S: confusion, ↓ LOC, tachycardia, tachypnea, headache, dizziness
TX: O2, ventilatory support, naloxone if OD', '{L11A_03}'),
  ('Respiratory alkalosis — pH, PaCO2, causes, S&S, TX', 'pH ↑ | PaCO2 ↓
Causes: anxiety, panic attack, pain, sepsis, fever
S&S: hyperventilation, tingling/numbness, headache, dizziness, hypokalemia
TX: slow breathing, rebreather bag, treat cause', '{L11A_03}'),
  ('Metabolic acidosis — pH, HCO3−, causes, S&S, TX', 'pH ↓ | HCO3− ↓
Causes: renal failure, DKA, diarrhea (losing HCO3−), sepsis/lactic acid, ASA OD
S&S: Kussmaul''s breathing, headache, confusion, N/V, hyperkalemia
TX: treat cause, possible bicarb order', '{L11A_04}'),
  ('Metabolic alkalosis — pH, HCO3−, causes, S&S, TX', 'pH ↑ | HCO3− ↑
Causes: vomiting, NG suction, furosemide, excess antacids
S&S: hypoventilation, dizziness, tingling, HYPERTONIC MUSCLES, hypokalemia
TX: treat cause, K+ replacement, antiemetics', '{L11A_04}'),
  ('All 4 ABG disorders — pH direction and which value is abnormal', 'Resp. Acidosis: pH ↓, PaCO2 ↑
Resp. Alkalosis: pH ↑, PaCO2 ↓
Met. Acidosis: pH ↓, HCO3− ↓
Met. Alkalosis: pH ↑, HCO3− ↑', '{L11A_03,L11A_04}'),
  ('ICF vs ECF — location and main ions', 'ICF (intracellular): inside cells — largest compartment — main ions: K+, Mg2+, phosphate
ECF (extracellular): outside cells — subtypes: interstitial, intravascular, transcellular
Main ECF ion: Na+', '{L11F_01}'),
  ('ECF subtypes — interstitial, intravascular, transcellular', 'Interstitial: between cells and blood vessels — where EDEMA forms
Intravascular: plasma inside blood vessels (Na+, albumin)
Transcellular: CSF, pleural fluid, peritoneal, synovial fluids', '{L11F_01}'),
  ('What is third spacing?', 'Fluid trapped in a space the body cannot access or use
Examples: ascites, pericardial effusion, burn blisters, pleural effusion
Danger: circulating volume drops even though fluid hasn''t left the body', '{L11F_01}'),
  ('Osmosis vs diffusion vs active transport', 'Osmosis: WATER moves low → high concentration (passive, no ATP)
Diffusion: SOLUTES move high → low concentration (passive, no ATP)
Active transport: electrolytes move low → high concentration (requires ATP — only energy-requiring mechanism)', '{L11F_02}'),
  ('Filtration — definition and example', 'Water and particles move from high pressure → low pressure (passive)
Example: blood flowing from arteries into capillaries', '{L11F_02}'),
  ('10 signs of need for fluids (hypovolemia) — what is the FIRST sign?', 'FIRST: Thirst
1. Thirst  2. Headache  3. Fatigue  4. Concentrated/decreased urine
5. ↑ HR and low BP  6. Dry mouth and eyes  7. Lack of coordination
8. Muscle cramps  9. Constipation  10. Weakness, trembling, lack of mental clarity', '{L11F_03}'),
  ('ADH — what triggers it and what it does', 'Triggered by: low fluid volume or ↓ BP
Released by posterior pituitary → kidneys RETAIN water → ↑ blood volume → ↑ BP
ADH released = urine concentrated (dark, SG >1.030)
ADH suppressed = urine dilute (pale, SG <1.002)', '{L11F_04}'),
  ('SIADH vs diabetes insipidus — ADH problem and result', 'SIADH: too MUCH ADH → excess water retained → dilutional hyponatremia → confusion, seizures
Diabetes insipidus: too LITTLE ADH → massive water loss → dehydration → hypernatremia', '{L11F_04}'),
  ('Hypovolemia — labs', '↑ BUN, ↑ Hct (hemoconcentration), ↑ Na+, ↑ urine specific gravity (>1.030)
VS: tachycardia, hypotension, tachypnea', '{L11F_05,LAB_01,LAB_02}'),
  ('Hypervolemia — signs and symptoms', 'Rapid weight gain, JVD, pitting edema, crackles, dyspnea, bounding pulse, HTN, ↑ RR, AMS', '{L11F_05}'),
  ('Hypervolemia — labs', '↓ BUN, ↓ Hct (hemodilution), ↓ Na+, ↓ urine specific gravity (<1.002)', '{L11F_05,LAB_01,LAB_02}'),
  ('Hypovolemia vs hypervolemia — BUN, Hct, urine SG', 'Hypovolemia: ↑ BUN, ↑ Hct, urine SG >1.030
Hypervolemia: ↓ BUN, ↓ Hct, urine SG <1.002', '{L11F_05}'),
  ('Nursing interventions to INCREASE fluid intake (hypovolemia)', 'Offer fluid preferences, encourage oral fluids throughout day
IV fluids as ordered (isotonic 0.9% NS)
Monitor I&O, daily weights, VS, mental status
Mouth care for dry mucous membranes', '{L11F_06}'),
  ('Nursing interventions to RESTRICT fluid intake (hypervolemia)', 'Measure ALL intake
Reserve liquids for BETWEEN meals — not with meals
Offer ice chips for thirst
Do NOT leave fluids at bedside
Diuretics as ordered, low-sodium diet
Monitor I&O, daily weights, lung sounds', '{L11F_06}'),
  ('Isotonic, hypotonic, hypertonic — fluid shift and examples', 'Isotonic: no shift, stays in ECF | Examples: 0.9% NS, LR
Hypotonic: water moves INTO cells → swell | Examples: 0.45% NS, D5W
Hypertonic: water moves OUT of cells → shrink | Examples: D5NS, 3% NS', '{L11F_07}'),
  ('Isotonic fluids — uses and caution', 'Uses: hypovolemia, dehydration, fast volume replacement (0.9% NS), blood loss (LR)
Caution: risk of fluid overload — monitor in CHF', '{L11F_07}'),
  ('Hypotonic fluids — uses and caution', 'Uses: intracellular dehydration, DKA
NEVER use with ↑ ICP, stroke, or head injury — causes cerebral edema', '{L11F_07}'),
  ('Hypertonic fluids — uses and caution', 'Uses: cerebral edema, severe hyponatremia, volume expansion
Must run SLOW — risk of hypervolemia
Monitor blood glucose (glucose-containing solutions)', '{L11F_07}'),
  ('Hyponatremia — normal value, causes, S&S, TX', 'Normal Na+: 135–145 mEq/L | Hypo: <135
Causes: diuretics, GI loss, excess water, SIADH
S&S: confusion, N/V, weakness, muscle cramps, SEIZURES (brain cells swell)
TX: ↑ oral Na+, IV NS, fluid restriction if water overload', '{L11F_08,LAB_01,LAB_02}'),
  ('Hypernatremia — causes, S&S, TX', 'Na+ >145 mEq/L
Causes: dehydration, excess Na+ intake, profuse sweating, DI, hypertonic tube feeds
S&S: thirst, elevated temp, dry sticky mucous membranes, AMS, seizures (brain cells shrink)
TX: restrict Na+, increase water, IV D5W', '{L11F_08,LAB_01,LAB_02}'),
  ('Hypokalemia — normal value, #1 cause, ECG finding, digoxin risk', 'Normal K+: 3.5–5.0 mEq/L | Hypo: <3.5
#1 cause: furosemide (loop diuretic)
Other causes: vomiting, diarrhea, NG suction
S&S: muscle weakness, dysrhythmias, paresthesias
ECG: FLAT T wave
Low K+ → ↑ digoxin toxicity', '{L11F_08,LAB_01,LAB_02}'),
  ('Hyperkalemia — causes, S&S, ECG finding', 'K+ >5.0 mEq/L
Causes: renal failure, K+-sparing diuretics, acidosis, hemolyzed sample
S&S: muscle weakness, dysrhythmias, flaccid paralysis
ECG: TALL T wave', '{L11F_08,LAB_01,LAB_02}'),
  ('Hypokalemia vs hyperkalemia — ECG finding for each', 'Hypokalemia: FLAT T wave
Hyperkalemia: TALL T wave
Both cause cardiac dysrhythmias', '{L11F_08,LAB_02}'),
  ('Hypocalcemia — normal value, causes, S&S, 2 key signs', 'Normal Ca2+: 8.5–10.5 mg/dL | Hypo: <8.5
Causes: hypoparathyroidism (after thyroid/parathyroid surgery!), Vit D deficiency, alkalosis
S&S: muscle cramps, tetany, seizures
Trousseau''s sign: BP cuff inflated 3 min → carpopedal spasm
Chvostek''s sign: tap facial nerve → facial twitch', '{L11F_08,LAB_01,LAB_02}'),
  ('Hypercalcemia — causes and S&S', 'Ca2+ >10.5 mg/dL
Causes: hyperparathyroidism, bone disease, prolonged immobilization, thiazide diuretics
S&S: N/V, muscle weakness, bradycardia, constipation, kidney stones, polyuria', '{L11F_08,LAB_01,LAB_02}'),
  ('Hypomagnesemia — causes, S&S, digoxin risk', 'Normal Mg2+: 1.3–2.1 mEq/L | Hypo: <1.3
Causes: chronic alcoholism, malabsorption, DKA, prolonged NG suction
S&S: neuromuscular irritability, dysrhythmias, disorientation
Low Mg2+ → ↑ digoxin toxicity (same as low K+)', '{L11F_08,LAB_01,LAB_02}'),
  ('Hypermagnesemia — causes and S&S', 'Mg2+ >2.1 mEq/L
Causes: renal failure, excess Mg2+ from antacids or laxatives
S&S: HYPOACTIVE reflexes, bradycardia, flushing, hypotension, drowsiness', '{L11F_08,LAB_01,LAB_02}'),
  ('Which 2 electrolytes increase digoxin toxicity when LOW?', 'Potassium (K+) and Magnesium (Mg2+)
Both low K+ and low Mg2+ sensitize the heart to digoxin → toxicity', '{L11F_08,MED_01}'),
  ('Sodium — normal value and role', '135–145 mEq/L
Main ECF electrolyte — regulates fluid volume, blood pressure, nerve impulses', '{L11F_08,LAB_01}'),
  ('Potassium — normal value and role', '3.5–5.0 mEq/L
Main ICF electrolyte — cardiac rhythm, muscle contraction', '{L11F_08,LAB_01}'),
  ('Calcium — normal value and role', '8.5–10.5 mg/dL
Bone/teeth structure, muscle contraction, nerve impulse transmission, cardiac automaticity', '{L11F_08,LAB_01}'),
  ('Magnesium — normal value and role', '1.3–2.1 mEq/L
Supports nerve and cardiac electrical activity, maintains normal K+ levels', '{L11F_08,LAB_01}'),
  ('Peripheral IV — gauge rule and replacement schedule', 'Lower gauge number = larger lumen (18g > 22g)
Replace every 72 hours', '{L12I_01}'),
  ('IV infiltration — cause, S&S, treatment', 'Cause: NON-vesicant fluid leaks into tissue
S&S: swelling, pale/cool/hard skin at site, slow or stopped IV
TX: STOP IV, restart above site or other arm, elevate', '{L12I_01}'),
  ('IV extravasation — cause, S&S, treatment', 'Cause: VESICANT drug leaks into tissue → necrosis
Vesicants: chemo, dopamine, dextrose >10%, TPN, IV nitroglycerin
S&S: same as infiltration early + blistering/necrosis late
TX: STOP immediately, call MD, antidote, cold compress, elevate', '{L12I_01}'),
  ('Infiltration vs extravasation — key difference', 'Infiltration: non-vesicant — no tissue destruction
Extravasation: vesicant — causes tissue necrosis
Both: STOP IV immediately', '{L12I_01}'),
  ('IV phlebitis vs thrombophlebitis — difference and compress type', 'Phlebitis: inflammation only — redness, pain, warmth, cord
TX: STOP IV → COLD compress
Thrombophlebitis: clot + inflammation — same plus hard cord
TX: STOP IV, restart opposite side, all new equipment → WARM compress', '{L12I_01}'),
  ('PICC line — insertion site, use, RN responsibility', 'Inserted in antecubital fossa → advanced to superior vena cava
Use: long-term, prolonged antibiotics, home care
RN: assess site AND catheter length every shift — length change = migration', '{L12I_02}'),
  ('Implanted port (Mediport) — access and key point', 'Surgically implanted under skin — long-term use
Access: HUBER NEEDLE ONLY — sterile procedure
Concealed under skin when not in use', '{L12I_02}'),
  ('Non-tunneled CVC — insertion and requirement before use', 'Inserted into subclavian or jugular vein by MD
X-ray MUST confirm placement BEFORE first use', '{L12I_02}'),
  ('Blood product indications — PRBCs, platelets, plasma', 'PRBCs: anemia, significant blood loss — restore O2-carrying capacity
Platelets: low platelet count, clotting disorders
Plasma/FFP: clotting factor deficits, warfarin reversal', '{L12I_03}'),
  ('Blood transfusion — 4 time rules', 'Initiate within 30 MINUTES of release from blood bank
Infuse in NOT LESS than 2 hours, NOT MORE than 4 hours
If not done in 4 hours → STOP and WASTE
Stay with patient for FIRST 15 MINUTES and retake vitals', '{L12I_04}'),
  ('Blood transfusion setup — IV fluid, gauge, tubing', 'ONLY 0.9% Normal Saline — dextrose causes RBC lysis
18–20 gauge IV
Y-tubing
If dextrose running → completely new IV line
2-nurse check required before hanging', '{L12I_04}'),
  ('Universal first step for ALL transfusion reactions', 'STOP the transfusion IMMEDIATELY
Replace tubing and hang 0.9% NS
Notify MD — then identify and treat the specific reaction', '{L12I_05}'),
  ('5 transfusion reactions — name and cause for each', '1. Febrile: WBC/protein sensitivity
2. Allergic: allergy to blood components
3. Bacterial: contaminated blood product
4. Hemolytic: INCOMPATIBLE BLOOD — most serious, most preventable
5. Circulatory overload: too much or too fast', '{L12I_05}'),
  ('Febrile transfusion reaction — S&S and TX', 'S&S: fever, chills, warm flushed skin, aches
TX: STOP, NS, notify MD, acetaminophen', '{L12I_05}'),
  ('Allergic transfusion reaction — S&S and TX', 'S&S: flushing, itching, hives, wheezing — severe = anaphylaxis
TX: STOP, NS, antihistamine (mild) or epinephrine (anaphylaxis)', '{L12I_05}'),
  ('Hemolytic reaction — S&S and protocol', 'S&S: fever, chills, chest pain, dyspnea, tachycardia, hypotension → FATAL
Protocol: STOP, new NS via NEW tubing, notify MD STAT
Send: blood bag + tubing + venous sample + FIRST VOIDED URINE to lab
Preventable with 2-nurse check', '{L12I_05}'),
  ('Circulatory overload reaction — S&S and TX', 'S&S: persistent cough, crackles, HTN, JVD
TX: slow or stop transfusion, sit upright, notify MD, anticipate furosemide (Lasix)', '{L12I_05}'),
  ('Which transfusion reaction is most serious and most preventable?', 'Hemolytic — caused by incompatible blood (wrong blood to wrong patient)
Prevented by 2-nurse verification check before hanging', '{L12I_05}'),
  ('Causes of escalating healthcare costs', 'Aging population → more chronic conditions
Higher survival rates → costly long-term care
Administrative waste from insurance complexity
Lack of hospital competition → unchecked prices
Third-party payers insulate consumers from real cost
Overuse: unnecessary tests, longer LOS, supply waste
Rising drug and technology costs', '{L12M_01}'),
  ('ANA Resource Stewardship Standard', 'The registered nurse utilizes appropriate resources to plan, provide, and sustain evidence-based nursing services that are safe, effective, financially responsible, and used judiciously.', '{L12M_02}'),
  ('Nurse''s role in cost containment', 'Bring only needed supplies into patient room
Early assessment → prevent complications (e.g., turn schedule prevents pressure injuries)
Infection control — CAUTI and VAP are preventable and costly
Delegate appropriately to UAPs
Document for continuity — prevents duplicate testing
Cluster care', '{L12M_02}'),
  ('Shifting paradigms in healthcare — past vs future', 'Past: sick care, provider-centric, task-focused, no quality accountability
Future: prevention and care coordination, patient as partner, value-based payment, nursing advocacy', '{L12M_02}'),
  ('Heparin vs enoxaparin vs warfarin — monitoring lab for each', 'Heparin: PTT or aPTT (therapeutic = 1.5–2× normal)
Enoxaparin: NO routine monitoring required
Warfarin: PT/INR (therapeutic INR = 2–3)', '{L910_07,MED_02}'),
  ('Heparin vs enoxaparin vs warfarin — antidote for each', 'Heparin: protamine sulfate
Enoxaparin: no specific antidote (monitor for bleeding)
Warfarin: vitamin K', '{L910_07,MED_02}'),
  ('Heparin vs enoxaparin vs warfarin — route for each', 'Heparin: SQ abdomen or IV — short-term
Enoxaparin: SQ abdomen ONLY — home/long-term use
Warfarin: oral (PO) — long-term', '{L910_07,MED_02}'),
  ('Enoxaparin — key advantage over heparin', 'Does NOT require routine serum monitoring (unlike heparin)
More convenient — used in nursing homes and for home self-administration', '{L910_07,MED_02}'),
  ('Warfarin dietary teaching', 'AVOID green leafy vegetables — they contain Vitamin K which counteracts warfarin
Consistent Vit K intake is key — do not suddenly start or stop', '{L910_07,MED_02}'),
  ('Bleeding precautions — all anticoagulants', 'Electric razor, soft toothbrush, no aspirin/NSAIDs, stool softeners, blow nose gently, wear shoes
No IM injections, no rectal temps
Report: bleeding >5 min, hematuria, black/tarry stools, petechiae, new headache or abdominal pain, bruising without injury', '{L910_07,MED_02}'),
  ('Furosemide (Lasix) — classification, action, #1 SE', 'Classification: loop diuretic — K+-LOSING
Action: inhibits Na+/K+/Cl− reabsorption in loop of Henle → excretes water, Na+, K+
Use: edema from CHF, excess fluid volume
#1 SE: HYPOKALEMIA', '{MED_03,L11F_08}'),
  ('Furosemide — IV rate rule and why it matters', 'Give at 20–40 mg/min
Faster rate → OTOTOXICITY (permanent hearing loss, tinnitus)', '{MED_03,L11F_08}'),
  ('Furosemide — full nursing implications', 'Monitor K+, BP/pulse before and during admin
Daily weights, I&O, lung sounds, skin turgor, edema
Assess for tinnitus and hearing loss
Give in AM (avoids disrupted sleep)
If on digoxin: monitor K+ closely — low K+ from Lasix → digoxin toxicity', '{MED_03,L11F_08}'),
  ('Furosemide other side effects', 'Dehydration, orthostatic hypotension, photosensitivity, Stevens-Johnson Syndrome', '{MED_03,L11F_08}'),
  ('Spironolactone — classification, key SE, teaching', 'Classification: K+-SPARING diuretic
Key SE: HYPERKALEMIA
Teaching: avoid salt substitutes (contain K+), avoid K+-rich foods', '{MED_03}'),
  ('Furosemide vs spironolactone — K+ effect', 'Furosemide: K+-LOSING → risk of hypokalemia → encourage K+-rich foods
Spironolactone: K+-SPARING → risk of hyperkalemia → avoid K+-rich foods and salt substitutes', '{MED_03,L11F_08}'),
  ('Potassium chloride (KCl) — HIGH ALERT nursing rules', 'HIGH ALERT drug
PO: give WITH FOOD — very irritating to GI
IV: MUST be diluted — NEVER IV push → cardiac arrest
Standard: 20 mEq in 100 mL NS over 1 hour
Contraindicated: hyperkalemia, severe renal disease', '{MED_03,L11F_08}'),
  ('Calcium carbonate — use, SE, nursing', 'Use: treatment and prevention of hypocalcemia
SE: arrhythmias, constipation
Nursing: monitor for Trousseau''s and Chvostek''s signs, monitor for hypercalcemia (kidney stones)', '{MED_03,L11F_08}'),
  ('Prednisone/Solu-Medrol — classification, action, side effects', 'Classification: corticosteroid
Action: suppresses inflammation and immune system
Side effects: HTN, weight gain, moon face, infection risk, oral thrush (fungal), hyperglycemia, mood swings
Key: RAISES blood sugar', '{MED_04,L78_09}'),
  ('Albuterol/Ipratropium — classification, action, side effects', 'Classification: bronchodilator (beta-2 agonist / anticholinergic)
Action: relaxes bronchial smooth muscle → dilates airways
Side effects: dry mouth, trembling, nervousness, palpitations, tachycardia, muscle cramps, N/V/D', '{MED_04,L78_09}'),
  ('Humulin R vs Humulin N — appearance and IV use', 'Humulin R (Regular): CLEAR — can be given IV
Humulin N (NPH): CLOUDY — CANNOT be given IV', '{MED_05}'),
  ('Humulin R vs Humulin N — onset and peak', 'Humulin R: onset 30–60 min | peak 2–4 hours (watch mid-morning hypoglycemia)
Humulin N: onset 2–4 hours | peak 4–10 hours (watch afternoon/evening hypoglycemia)', '{MED_05}'),
  ('Insulin — key nursing points', 'Monitor blood sugar before giving
Food must be available for Humulin R at or before peak
If hypoglycemic and AWAKE → offer juice
SQ injection: 2 inches from umbilicus', '{MED_05}'),
  ('Loperamide (Imodium) — when NOT to give', 'Do NOT give with abdominal pain of UNKNOWN cause
Do NOT give for ACUTE INFECTIOUS diarrhea — body needs to expel the organism
Assess stool frequency, consistency, and signs of dehydration', '{MED_05}'),
  ('CBC normal values — WBC, Hgb, Hct, Platelets', 'WBC: 5,000–10,000/mm³
Hgb: F 12–16 g/dL | M 14–18 g/dL
Hct: F 37–47% | M 42–52%
Platelets: 150,000–400,000/mm³', '{LAB_01}'),
  ('WBC differential — normal ranges', 'Neutrophils: 55–70%
Lymphocytes: 20–40%
Monocytes: 2–8%
Eosinophils: 1–4%
Basophils: 0.5–1.0%', '{LAB_01}'),
  ('RBC normal values', 'Male: 4.7–6.1
Female: 4.2–5.4', '{LAB_01}'),
  ('CMP electrolyte normal values', 'Na+: 135–145 mEq/L
K+: 3.5–5.0 mEq/L
Ca2+: 8.5–10.5 mg/dL
Mg2+: 1.3–2.1 mEq/L', '{LAB_01}'),
  ('CMP other normal values', 'Glucose: 70–110 mg/dL
BUN: 10–20 mg/dL
Creatinine: 0.5–1.3 mg/dL
Albumin: 3.5–5.0 g/dL
Hgb A1C: 4–5.9%', '{LAB_01}'),
  ('Cholesterol normal values', 'Total cholesterol: <200 mg/dL
LDL: <100 mg/dL
HDL: >60 mg/dL', '{LAB_01}'),
  ('Coagulation normal values', 'PT: 11–12.5 seconds
INR: 0.8–1.1
PTT: 60–70 seconds
aPTT: 30–40 seconds', '{LAB_01}'),
  ('Cardiac marker normal values', 'Troponin: <0.1 ng/mL
CK-MB: 55–170 U/L
BNP: <100 pg/mL', '{LAB_01}'),
  ('Urine specific gravity — normal range', '1.002–1.030', '{LAB_01}'),
  ('Routine urinalysis — normal values', 'Color: light amber to yellow | Appearance: clear | Odor: aromatic
pH: 5–9 | Protein: <20 mg/dL | Glucose: none | Ketones: none
WBC: 0–4 | RBC: ≤2 | Nitrates: negative', '{LAB_01}'),
  ('CRP normal value', '<10 mg/L
Elevation indicates inflammatory illness — may predict coronary events', '{LAB_01,LAB_02}'),
  ('WBC — significance of high and low', 'HIGH (>10,000): infection or inflammation
LOW: leukopenia → immunocompromised, unable to fight infection', '{LAB_02}'),
  ('Hemoglobin — significance of high and low', 'HIGH: polycythemia or dehydration (hemoconcentration)
LOW: anemia → ↓ O2 delivery → fatigue, dyspnea → indication for PRBC transfusion', '{LAB_02}'),
  ('Hematocrit — significance of high and low', 'HIGH: hemoconcentration (dehydration)
LOW: anemia, hemodilution (fluid overload), bleeding', '{LAB_02}'),
  ('Platelets — significance of high and low', 'HIGH: thrombocytosis → ↑ clot risk
LOW: thrombocytopenia → ↑ bleeding risk → indication for platelet transfusion', '{LAB_02}'),
  ('BUN — HIGH alone vs HIGH with HIGH creatinine', 'HIGH BUN alone = dehydration (kidneys working fine)
HIGH BUN + HIGH creatinine = suspect RENAL FAILURE', '{LAB_02}'),
  ('Creatinine — significance of high', 'HIGH: impaired GFR/kidney disease — BETTER indicator of kidney function than BUN
When elevated: restrict K+ foods (kidneys cannot excrete K+)', '{LAB_02}'),
  ('Albumin — significance of low', 'LOW (<3.5 g/dL): malnutrition → impairs wound healing, affects drug binding (warfarin, digoxin)', '{LAB_02}'),
  ('Urine specific gravity — significance of high and low', 'HIGH (>1.030): concentrated urine = hypovolemia/dehydration
LOW (<1.002): dilute urine = hypervolemia/fluid volume excess', '{LAB_02}'),
  ('LDL vs HDL — which is good, which is bad, and what each does', 'LDL (Bad/Loser): deposits plaque on vessel walls → atherosclerosis — normal <100
HDL (Good/Hero): removes LDL from blood — normal >60 (higher is better)', '{LAB_02}'),
  ('PT/INR — significance when elevated', 'Elevated PT/INR = ↑ bleeding risk
Patient on warfarin: therapeutic INR = 2–3
Above therapeutic = over-anticoagulated → bleeding risk', '{LAB_02}'),
  ('PTT/aPTT — significance when elevated', 'Elevated PTT/aPTT = ↑ bleeding risk
Patient on heparin: therapeutic = 1.5–2× normal
Above therapeutic = over-anticoagulated → bleeding risk', '{LAB_02}'),
  ('Glucose — significance of high and low', 'HIGH (>110): hyperglycemia — seen in DKA, corticosteroid use, stress response
LOW (<70): hypoglycemia — shakiness, diaphoresis, confusion, tachycardia', '{LAB_02}'),
  ('Hgb A1C — what it measures and normal value', 'Measures average blood glucose control over 2–3 months
Normal: 4–5.9%
Used to diagnose and monitor diabetes treatment', '{LAB_02}'),
  ('Troponin vs CK-MB — timing and best use for each', 'Troponin: rises 2–3 hrs, stays 1–2 WEEKS — most specific for MI, draw FIRST
CK-MB: rises 3–6 hrs, clears 1–2 days — best for detecting RE-INFARCTION', '{LAB_02}'),
  ('EKG/ECG — what it records', 'Records electrical impulses that stimulate the heart to contract
P wave = atrial contraction | QRS = ventricular contraction | T wave = repolarization', '{LAB_01,LAB_02}'),
  ('Echocardiogram — what it evaluates', 'Ultrasound of the heart — evaluates structure, function, valves, and how blood moves through the heart
Normal EF: 50–75% | EF <40% = systolic HF', '{LAB_01,LAB_02}'),
  ('Respiratory acidosis — pH and PaCO2 values', 'pH: LOW (<7.35)
PaCO2: HIGH (>45)
Cause: hypoventilation — CO2 retained', '{L11A_03}'),
  ('Respiratory acidosis — causes', 'COPD, opioid OD, apnea, airway obstruction, CHF, pneumonia', '{L11A_03}'),
  ('Respiratory acidosis — S&S and treatment', 'S&S: confusion, decreased LOC, tachycardia, tachypnea, headache, dizziness
TX: O2, ventilatory support, naloxone if opioid OD', '{L11A_03}'),
  ('Respiratory alkalosis — pH and PaCO2 values', 'pH: HIGH (>7.45)
PaCO2: LOW (<35)
Cause: hyperventilation — CO2 blown off', '{L11A_03}'),
  ('Respiratory alkalosis — causes', 'Anxiety, panic attack, pain, sepsis, fever', '{L11A_03}'),
  ('Respiratory alkalosis — S&S and treatment', 'S&S: hyperventilation, tingling/numbness, headache, dizziness, hypokalemia
TX: slow breathing, rebreather bag, treat cause', '{L11A_03}'),
  ('Metabolic acidosis — pH and HCO3− values', 'pH: LOW (<7.35)
HCO3−: LOW (<22)
Cause: acid buildup or base (HCO3−) loss', '{L11A_04}'),
  ('Metabolic acidosis — causes', 'Renal failure, DKA, diarrhea (losing HCO3−), sepsis/lactic acid, ASA OD', '{L11A_04}'),
  ('Metabolic acidosis — S&S and treatment', 'S&S: Kussmaul''s breathing (compensatory), headache, confusion, N/V, hyperkalemia
TX: treat cause, possible bicarb order', '{L11A_04}'),
  ('Metabolic alkalosis — pH and HCO3− values', 'pH: HIGH (>7.45)
HCO3−: HIGH (>26)
Cause: acid loss or base gain', '{L11A_04}'),
  ('Metabolic alkalosis — causes', 'Vomiting, NG suction, furosemide, excess antacids', '{L11A_04}'),
  ('Metabolic alkalosis — S&S and treatment', 'S&S: hypoventilation (compensatory), dizziness, tingling, hypertonic muscles, hypokalemia
TX: treat cause, K+ replacement, antiemetics', '{L11A_04}'),
  ('A patient has DKA. What ABG disorder do you expect and what breathing pattern?', 'Metabolic acidosis — pH low, HCO3− low
Kussmaul''s breathing — lungs compensating by blowing off CO2', '{L11A_04}'),
  ('A patient is anxious and hyperventilating. What ABG disorder?', 'Respiratory alkalosis — CO2 blown off → pH rises', '{L11A_03}'),
  ('A patient has been vomiting for 3 days. What ABG disorder?', 'Metabolic alkalosis — HCl lost from stomach → acid loss → pH rises', '{L11A_04}'),
  ('A patient with COPD is drowsy and confused. What ABG disorder?', 'Respiratory acidosis — hypoventilation → CO2 retained → pH drops', '{L11A_03}'),
  ('CO2 and HCO3− — which is an acid and which is a base?', 'CO2 is an ACID — moves OPPOSITE to pH (↑CO2 = ↓pH)
HCO3− is a BASE — moves SAME direction as pH (↓HCO3− = ↓pH)', '{L11A_02}'),
  ('What does JVD indicate and at what position is it assessed?', 'JVD = jugular vein distension
Assessed at 15–45 degrees (semi-Fowler''s)
Indicates: right HF or fluid overload', '{L910_02}'),
  ('Conduction system backup rates — if SA fails, if both SA and AV fail', 'SA fails → AV node takes over (40–60 bpm)
Both fail → Purkinje fibers fire at <40 bpm (very slow but life-sustaining)', '{L910_01}'),
  ('PAD — where do wounds/ulcers appear?', 'On the TOES and foot — from arterial insufficiency (distal ischemia)', '{L910_05}'),
  ('PVD — where do ulcers appear?', 'On the LOWER LEG (above ankle) — from venous stasis and pooling', '{L910_05}'),
  ('What is a thrill vs a bruit?', 'Thrill: abnormal vibration FELT on palpation — turbulent blood flow
Bruit: abnormal sound HEARD on auscultation — turbulent blood flow', '{L910_02}'),
  ('What causes left HF most commonly?', 'MI (myocardial infarction), hypertension, cardiomyopathy — LV becomes too weak to pump effectively', '{L910_04}'),
  ('What often causes right HF?', 'Left HF — when the left side fails, pressure backs up into the lungs → RV eventually fails too', '{L910_04}'),
  ('What is BNP and what does it indicate?', 'B-type natriuretic peptide — released by the ventricle when it is overstretched
Elevated BNP = left HF — higher level = more severe', '{L910_03,LAB_02}'),
  ('PAD — nursing interventions', 'Keep legs DOWN (gravity assists flow)
Daily foot care — inspect for wounds
Smoking cessation
No restrictive clothing or crossing legs', '{L910_05}'),
  ('PVD — nursing interventions', 'Keep legs UP (gravity assists venous return)
Compression stockings
Ambulation — activates calf muscle pump
No crossing legs
Ankle circles and calf pumps', '{L910_05}'),
  ('Hypovolemia — signs and symptoms (non-lab)', 'Tachycardia, hypotension (thready pulse), tachypnea, elevated temperature
Dry mucous membranes, poor skin turgor, capillary refill >3 sec
Decreased urine output, concentrated dark urine, AMS', '{L11F_05}'),
  ('Daily weight rule for fluid monitoring', 'Same time, same scale, same clothing every day
Report: gain >2 lb in 1 day OR >5 lb in 1 week', '{L11F_05,L11F_06}'),
  ('Minimum urine output indicating adequate perfusion', '30–50 mL/hour', '{L11F_05}'),
  ('RAAS — what it is and clinical relevance', 'Renin-Angiotensin-Aldosterone System
Low fluid → kidneys release renin → angiotensin II → kidneys hold Na+ and water → ↑ BP
ACE inhibitors block this → ↓ BP (e.g. enalapril)', '{L11F_04,L910_07}'),
  ('How does isotonic fluid differ from LR vs 0.9% NS in terms of use?', 'Both isotonic — both stay in ECF
0.9% NS: used for hypovolemia, GI losses, dehydration
LR: preferred for blood loss, trauma, surgery (contains electrolytes that match plasma better)', '{L11F_07}'),
  ('Bacterial transfusion reaction — S&S and TX', 'S&S: high fever, chills, severe hypotension, vomiting, diarrhea
Cause: contaminated blood product
TX: STOP transfusion, NS, notify MD, blood cultures, antibiotics as ordered', '{L12I_05}'),
  ('IV site infection — S&S and TX', 'S&S: redness, swelling, warmth, EXUDATE (pus) at site, fever
TX: remove IV, sterile dressing, notify MD, culture site, antibiotics if ordered', '{L12I_01}'),
  ('Vesicant drugs — what are they and why do they matter?', 'Drugs that cause tissue destruction if they leak (extravasation)
Examples: chemotherapy, dopamine, dextrose >10%, TPN, IV nitroglycerin, acyclovir
Always verify IV patency before giving a vesicant', '{L12I_01}'),
  ('Why must you verify IV patency before giving a vesicant?', 'If the IV has infiltrated and you give a vesicant, it causes tissue necrosis — you cannot undo the damage once the drug extravasates', '{L12I_01}'),
  ('2-nurse check for transfusion — what is verified?', 'Right patient (2 identifiers)
Right blood type (ABO and Rh match)
Expiration date on blood bag
Blood bag ID number matches the paperwork', '{L12I_04}'),
  ('Digoxin — when to HOLD and what to check before giving', 'Hold if apical pulse <60 bpm
Check apical pulse for 1 FULL MINUTE before giving
Also check digoxin level and K+ — low K+ increases toxicity risk', '{MED_01}'),
  ('Nitroglycerin — headache teaching', 'Headache is a COMMON and EXPECTED side effect — caused by vasodilation
It typically decreases with continued therapy
Do not stop taking it because of headache', '{MED_01}'),
  ('Nitroglycerin — why must the patient sit before receiving?', 'It causes vasodilation → drop in BP → orthostatic hypotension
Sitting prevents a fall if the patient becomes dizzy', '{MED_01}'),
  ('Spironolactone — full nursing implications', 'Monitor K+ levels throughout therapy
Monitor BP and I&O
Daily weights
Give in AM to avoid disrupted sleep
Teach: avoid salt substitutes and K+-rich foods', '{MED_03}'),
  ('Furosemide — when to give it and why', 'Give in the MORNING (AM)
If given at night → patient wakes up multiple times to urinate → disrupted sleep', '{MED_03,L11F_08}'),
  ('KCl IV — what happens if given IV push?', 'Cardiac arrest — IV potassium must ALWAYS be diluted and infused slowly
Standard: 20 mEq in 100 mL NS over 1 hour', '{MED_03}'),
  ('Calcium carbonate — signs of hypocalcemia to monitor for', 'Trousseau''s sign: inflate BP cuff 3 min → carpopedal spasm = positive
Chvostek''s sign: tap facial nerve → facial twitch = positive
Also monitor: paresthesias, muscle twitching', '{MED_03,L11F_08}'),
  ('Humulin R — when is the hypoglycemia risk highest?', 'At PEAK — 2–4 hours after injection
If given at 0700 → watch for hypoglycemia 0900–1100 (mid-morning)', '{MED_05}'),
  ('Humulin N — when is the hypoglycemia risk highest?', 'At PEAK — 4–10 hours after injection
If given at 0700 → watch for hypoglycemia 1100–1700 (afternoon/evening)', '{MED_05}'),
  ('Prednisone — why does it raise blood sugar?', 'Corticosteroids cause gluconeogenesis and insulin resistance → blood glucose rises
Monitor blood sugar especially in diabetic patients and watch for new-onset hyperglycemia', '{MED_04,L78_09}'),
  ('Atenolol — why monitor EKG?', 'Beta-blockers slow the heart rate and can affect cardiac conduction
Monitor for bradycardia and heart block on EKG', '{MED_01}'),
  ('Albumin — significance of HIGH', 'Mildly elevated albumin usually reflects dehydration (hemoconcentration)
Not clinically significant on its own', '{LAB_02}'),
  ('Hgb A1C — what makes it better than a fasting glucose?', 'Reflects average blood glucose over 2–3 months, not just one point in time
Not affected by recent eating — better for monitoring long-term diabetic control', '{LAB_02}'),
  ('CRP — what does elevation indicate?', 'Inflammation — can indicate inflammatory illness and may predict coronary events
Normal: <10 mg/L', '{LAB_02}'),
  ('RBC — significance of low', 'LOW: anemia — fewer RBCs means less hemoglobin available to carry O2
Leads to tissue hypoxia, fatigue, dyspnea', '{LAB_02}');