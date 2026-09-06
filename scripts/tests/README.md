# Podcast pipeline tests

No test runner and no dependencies — plain Node, run them directly:

```
node --experimental-strip-types scripts/tests/checkpoint-placement.test.mjs
node --experimental-strip-types scripts/tests/pipeline-wiring.test.mjs
```

Both load the real `supabase/functions/generate-podcast-script/index.ts` rather
than a copy, so they break when that file changes shape. Node cannot resolve the
function's `jsr:` type-only import, so each harness blanks that one line and
leaves the rest of the source alone.

**checkpoint-placement.test.mjs** — regression cover for the bug where two
checkpoints both came back at `position_in_script = 8760` (the script length),
so playback would have run the whole episode with no pause and then fired both
questions back to back. Every fixture uses a format the model has actually
produced (marker inline, before the question) rather than the format the prompt
asks for — that mismatch is what the previous test missed.

**pipeline-wiring.test.mjs** — runs the whole handler with `fetch` faked
(PostgREST, ListModels, Gemini) and canned model answers, and asserts the report
shape: coverage on both passes, the unsourced-claims pass and its repair round,
the scoping dump with reasons and overlap ranking, and checkpoint offsets. It
tests wiring, not the quality of any model output.
