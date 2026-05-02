-- Unit 1 objectives seed — NUR118 Lectures 1–6
-- IDs follow pattern NUR118-L{n}-OBJ{n}, matching existing Unit 2 convention.
-- Safe to re-run: INSERT only; no existing rows are touched.

INSERT INTO objectives (id, lecture, description) VALUES
-- Lecture 1: Body Defense / Infection Control
('NUR118-L1-OBJ1',  'NUR118-L1', 'Describe infection & identify risk factors for infection'),
('NUR118-L1-OBJ2',  'NUR118-L1', 'Differentiate between Healthcare Acquired Infection (HAI) & Nosocomial'),
('NUR118-L1-OBJ3',  'NUR118-L1', 'Understand the six links in the chain of infection'),
('NUR118-L1-OBJ4',  'NUR118-L1', 'Describe the stages of a typical infectious process: incubation, prodromal, illness, decline, convalescence'),
('NUR118-L1-OBJ5',  'NUR118-L1', 'Discuss classifications of infections: local vs systemic, acute vs chronic, latent'),
('NUR118-L1-OBJ6',  'NUR118-L1', 'Discuss body''s Primary Line of Defense'),
('NUR118-L1-OBJ7',  'NUR118-L1', 'Discuss factors that place an individual at risk for infection'),
('NUR118-L1-OBJ8',  'NUR118-L1', 'Identify activities that promote immune function'),
('NUR118-L1-OBJ9',  'NUR118-L1', 'Discuss medical asepsis & surgical asepsis, principles to maintain sterile technique'),
('NUR118-L1-OBJ10', 'NUR118-L1', 'Discuss Standard Precautions'),
('NUR118-L1-OBJ11', 'NUR118-L1', 'Discuss Transmission-based precautions with 3 examples each (Contact, Droplet, Airborne)'),
('NUR118-L1-OBJ12', 'NUR118-L1', 'Differentiate between transmission-based precautions and Protective Environment'),
('NUR118-L1-OBJ13', 'NUR118-L1', 'List nursing actions/interventions that contribute to medical & surgical asepsis'),
('NUR118-L1-OBJ14', 'NUR118-L1', 'List nursing interventions that promote wellness and support host defenses'),

-- Lecture 2: Skin Integrity / Wound Care + Pressure Injuries
('NUR118-L2-OBJ1',  'NUR118-L2', 'Discuss 12 factors that affect skin integrity'),
('NUR118-L2-OBJ2',  'NUR118-L2', 'Describe classifications of wounds: skin integrity, length of time for healing, level of contamination, depth of wound'),
('NUR118-L2-OBJ3',  'NUR118-L2', 'List & describe types of wound drainage'),
('NUR118-L2-OBJ4',  'NUR118-L2', 'List & describe types of wound healing'),
('NUR118-L2-OBJ5',  'NUR118-L2', 'Describe phases of wound healing'),
('NUR118-L2-OBJ6',  'NUR118-L2', 'Complications of wound healing'),
('NUR118-L2-OBJ7',  'NUR118-L2', 'Define pressure injury'),
('NUR118-L2-OBJ8',  'NUR118-L2', 'List intrinsic & extrinsic factors in development of pressure injuries'),
('NUR118-L2-OBJ9',  'NUR118-L2', 'Describe stages of pressure injuries'),
('NUR118-L2-OBJ10', 'NUR118-L2', 'Discuss Braden Scale & its 6 categories of assessment'),
('NUR118-L2-OBJ11', 'NUR118-L2', 'List interventions to prevent pressure injuries'),
('NUR118-L2-OBJ12', 'NUR118-L2', 'List indications for use of heat therapy and cold therapy'),

-- Lecture 3: Pharmacology
('NUR118-L3-OBJ1',  'NUR118-L3', 'Sources of drug information'),
('NUR118-L3-OBJ2',  'NUR118-L3', 'Name 3 ways drugs are named'),
('NUR118-L3-OBJ3',  'NUR118-L3', 'Classification of drugs'),
('NUR118-L3-OBJ4',  'NUR118-L3', 'Routes of administration (Table 26-1, pp 602-608)'),
('NUR118-L3-OBJ5',  'NUR118-L3', 'Discuss the 4 concepts of pharmacokinetics'),
('NUR118-L3-OBJ6',  'NUR118-L3', 'Drug concentration terms: peak, trough, half life, onset of action, duration of action'),
('NUR118-L3-OBJ7',  'NUR118-L3', 'Pharmacodynamics: primary effects, secondary effects'),
('NUR118-L3-OBJ8',  'NUR118-L3', 'Drug interactions: antagonistic, synergistic, agonist, incompatibilities'),

-- Lecture 4: Mobility
('NUR118-L4-OBJ1',  'NUR118-L4', 'Discuss good body mechanics that you will use in your practice'),
('NUR118-L4-OBJ2',  'NUR118-L4', 'Purpose of ROM'),
('NUR118-L4-OBJ3',  'NUR118-L4', 'Difference between AROM & PROM'),
('NUR118-L4-OBJ4',  'NUR118-L4', 'Factors affecting mobility'),
('NUR118-L4-OBJ5',  'NUR118-L4', 'Complication & Interventions of immobility by system: Musculoskeletal, Cardiovascular, Respiratory, Metabolic, GI, GU, Integumentary, Psychosocial'),

-- Lecture 5: Perioperative Nursing (Part 1)
('NUR118-L5-OBJ1',  'NUR118-L5', 'Name & differentiate the three phases of the perioperative period'),
('NUR118-L5-OBJ2',  'NUR118-L5', 'Describe the 4 ways in which surgeries can be classified'),
('NUR118-L5-OBJ3',  'NUR118-L5', 'Discuss factors that affect the degree of risk of surgery'),
('NUR118-L5-OBJ4',  'NUR118-L5', 'Describe nursing interventions/responsibilities in the preoperative period'),
('NUR118-L5-OBJ5',  'NUR118-L5', 'Discuss informed consent & roles of surgeon & nurse'),
('NUR118-L5-OBJ6',  'NUR118-L5', 'What is "Universal Protocol"? "Time Out"'),
('NUR118-L5-OBJ7',  'NUR118-L5', 'Discuss roles in OR: circulating nurse, scrub nurse'),
('NUR118-L5-OBJ8',  'NUR118-L5', 'Discuss role of PACU nurse'),

-- Lecture 6: Perioperative Part 2 + Pain Management
('NUR118-L6-OBJ1',  'NUR118-L6', 'Discuss responsibilities of the nurse on the surgical floor'),
('NUR118-L6-OBJ2',  'NUR118-L6', 'Discuss diet progression and what needs to be assessed before starting diet'),
('NUR118-L6-OBJ3',  'NUR118-L6', 'Name the 3 drains and nurse''s responsibility in care'),
('NUR118-L6-OBJ4',  'NUR118-L6', 'Wound assessment: REEDA'),
('NUR118-L6-OBJ5',  'NUR118-L6', 'Differentiate between dehiscence and evisceration and list nursing interventions for each'),
('NUR118-L6-OBJ6',  'NUR118-L6', 'Post op complications: list S&S, nursing interventions for prevention & treatment (Hemorrhage, Infection, Thrombi, Respiratory)'),
('NUR118-L6-OBJ7',  'NUR118-L6', 'List 3 ways pain is classified'),
('NUR118-L6-OBJ8',  'NUR118-L6', 'List 4 pain assessment scales and when to use'),
('NUR118-L6-OBJ9',  'NUR118-L6', 'List non-pharmacologic interventions (16)'),
('NUR118-L6-OBJ10', 'NUR118-L6', 'Name non-opioid pain medications (on your list, make drug card)'),
('NUR118-L6-OBJ11', 'NUR118-L6', 'Name opioid pain medications (on your list, make drug card)'),
('NUR118-L6-OBJ12', 'NUR118-L6', 'Describe function of PCA & Pros/Cons of use');
