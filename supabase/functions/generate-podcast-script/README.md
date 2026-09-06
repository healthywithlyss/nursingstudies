# generate-podcast-script

Phase 1 of the coached audio study feature: turns ONE section of a study guide
into a single-narrator lecture script with recall checkpoints, and verifies
coverage TWICE against two independently produced fact lists.

**Why two passes.** The model extracts the facts, writes the script, and grades
its own coverage — so anything extraction misses, nothing catches. The
`fact_tested` strings on `quiz_questions` were written in a separate earlier
pass over the same source, which makes them a genuine external check. The two
numbers are reported separately and never merged:

```
model-extracted facts 34/34, quiz-derived facts 41/47
```

A quiz fact is judged **in scope for a section by testing it against that
section's markdown**, never against the script — scoping against the script
would let a fact the script omitted be ruled "out of scope", which is the exact
failure this pass exists to catch. Quiz-derived misses are fed back into the
repair loop alongside the model-extracted ones, with an instruction to find them
in the section text and to leave them out rather than supply them from outside
knowledge.

Which questions are consulted: `objective_id` matching the course prefix derived
from `guide_slug` (`nur144-...` → `N144`), so `N144_L1` and `N144_SKILLS` are
both picked up and a future `N144_L2` needs no code change. Override with
`quiz_objective_prefix` or an explicit `quiz_objective_ids` array, or turn the
pass off with `cross_check: false`.

Admin only. Deployed with `verify_jwt = true`, so Supabase validates the JWT
before the function runs; the function then checks `profiles.role = 'admin'`
using the caller's own token (so RLS applies).

## Pipeline

1. Split the guide markdown on `##` headings (same rule the Study Guide page
   uses: the first H2, directly under the H1, is the guide subtitle).
2. Extract discrete atomic facts from the chosen section (one per entry, every
   table row and list item, numbers and units preserved verbatim, each
   conflicting value its own fact).
3. Write the narrator script for that section.
4. Pull `fact_tested` for the course and keep the ones this section's markdown
   actually states.
5. Write the narrator script for that section.
6. Semantically verify BOTH lists against the script — meaning, not string match.
7. Any fact reported missing, from either list, is fed back by name and the
   script is rewritten.
8. Up to `max_retries` (default 3). Misses remaining in either list → the
   episode is saved with `status = 'incomplete'` and every miss listed under
   `coverage_report.model_extracted.missing_facts` /
   `coverage_report.quiz_derived.missing_facts`. A fact is never silently
   dropped.

## Model selection

Model names change, so none is hardcoded as *the* model. The function calls
ListModels at runtime, filters to models supporting `generateContent`, and
takes the first match from a preference order (a bigger model for writing, a
faster one for extraction and verification). `POST {"action":"list-models"}`
returns what the key can actually see and what would be used.

## Request

```json
POST /functions/v1/generate-podcast-script
Authorization: Bearer <admin user JWT>
{
  "action": "generate",
  "guide_slug": "nur144-u1-l1",
  "section_heading": "ANATOMY & PHYSIOLOGY",
  "markdown": "<full guide markdown>",
  "max_retries": 3,
  "dry_run": false
}
```

`markdown` is sent by the app, which already has the file. Omit it and pass
`source_url` instead to have the function fetch the guide itself.

Other actions: `"list-sections"` (needs `markdown`), `"list-models"`.

## Response

`script`, `facts`, `checkpoints` and `coverage_report`, plus `episode_id` when
saved. `coverage_report` carries `model_extracted` and `quiz_derived`, each with
`total`, `covered`, `missed`, `missing_facts` and a per-fact list with the
supporting quote; `quiz_derived` also reports `pool` (distinct `fact_tested`
for the course) and `in_section` (how many of those this section states), plus
`error` when the cross-check could not run. Alongside them: a one-line
`summary`, the per-attempt history (both numbers per attempt), word count, and
the models used.

`checkpoints[].position_in_script` is a **character offset into `script`** —
the point where the narrator stops and waits for a spoken answer.
`expected_points` are the concrete things a correct answer must contain; phase 3
grades against them.
