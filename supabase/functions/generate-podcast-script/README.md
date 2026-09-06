# generate-podcast-script

Phase 1 of the coached audio study feature: turns ONE section of a study guide
into a single-narrator lecture script with recall checkpoints, and verifies
that every fact in the section actually made it into the script.

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
4. Semantically verify each fact against the script — meaning, not string match.
5. Any fact reported missing is fed back by name and the script is rewritten.
6. Up to `max_retries` (default 3). Still missing after that → the episode is
   saved with `status = 'incomplete'` and every missing fact is listed in
   `coverage_report.missing_facts`. A fact is never silently dropped.

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
saved. `coverage_report` carries `total_facts`, `covered`, `missed`,
`missing_facts`, a per-fact list with the supporting quote, the per-attempt
history, word count, and the models used.

`checkpoints[].position_in_script` is a **character offset into `script`** —
the point where the narrator stops and waits for a spoken answer.
`expected_points` are the concrete things a correct answer must contain; phase 3
grades against them.
