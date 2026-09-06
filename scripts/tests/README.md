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

## Phase 2 — audio

```
node --experimental-strip-types scripts/tests/document-reference-lint.test.mjs
node --experimental-strip-types scripts/tests/audio-segmentation.test.mjs
node --experimental-strip-types scripts/tests/audio-pipeline.test.mjs
```

**document-reference-lint.test.mjs** — the narrator must teach the material, not
describe the page it came from. Ten dirty fixtures (including the real
regression, "The source lays these two out side by side in a comparison table")
and ten clean ones, because a lint that trips on "the patient eats at the table"
or "the pain sits above the umbilicus" is worse than no lint at all.

**audio-segmentation.test.mjs** — where the audio is cut, and the WAV framing.
Three things here fail silently and are only noticed by ear: a split landing
mid-sentence, "H. pylori" being treated as a sentence end and read as two
utterances, and a malformed or wrong-rate WAV header. All three are
deterministic, so all three are asserted rather than listened to.

**audio-pipeline.test.mjs** — the whole handler with `fetch` faked (PostgREST,
Storage, ListModels, TTS). Covers the admin gate, TTS model discovery with the
filter inverted (it must pick the model the text side rejects, and must still
find one in a preview-only world), plan/synthesize/status/delete, that no
checkpoint marker ever reaches the synthesiser, and that regenerating a segment
replaces rather than duplicates it.

## Browser test

`listen.mjs` in the session scratchpad drives the listener page in Chromium at
320/375/1440 with the backend faked and a real generated WAV, asserting the
checkpoint pause, Continue, cross-device resume, progress writes, and zero
horizontal overflow. It is a scratch harness rather than a committed test
because it needs Playwright, which this repo deliberately does not depend on.
