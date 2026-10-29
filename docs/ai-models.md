# AI models for Qemmini (grading suggestions + assessment generation + handwritten OCR)

All AI features (grading suggestions on `/grading`, assessment generation on
`/assessments/generate`, handwritten-paper OCR on `/handwritten`) are
**provider-agnostic**: the server calls a plain
OpenAI-compatible `POST /chat/completions` endpoint with `fetch`. There is no
provider-specific SDK and no provider or model hardcoded in code. Everything
is chosen with server-side environment variables (never `VITE_`):

| Variable      | Required | Meaning |
| ------------- | -------- | ------- |
| `AI_BASE_URL` | Yes      | Base URL of an OpenAI-compatible API (no trailing slash needed). |
| `AI_MODEL`    | Yes      | Model name, exactly as the provider expects it. |
| `AI_API_KEY`  | For hosted providers | API key, sent as a Bearer token when set. |

If `AI_BASE_URL`/`AI_MODEL` are unset — or a hosted (non-local) base URL has
no key — the features show a clear "AI not configured" state instead of
failing silently. No default model is hardcoded in code: the deployer picks
the model in env.

## Using a free / open model (keep costs down)

Any OpenAI-compatible provider works. Free/open options to point at:

- **OpenRouter free tier** — set `AI_BASE_URL` to OpenRouter's OpenAI-compatible
  endpoint and `AI_MODEL` to a `:free`-suffixed model. Free-tier models and
  availability change often: check OpenRouter's model list and confirm the
  model is actually free before relying on it.
- **Groq free tier** — set `AI_BASE_URL` to Groq's OpenAI-compatible endpoint
  and `AI_MODEL` to a model on Groq's free tier (rate limits apply).
- **Hugging Face Inference free tier** — use an Inference Provider that
  exposes an OpenAI-compatible endpoint, and set `AI_MODEL` to the hosted
  model id. Free-tier rate limits apply.
- **Self-hosted Ollama** — run Ollama on your own machine/server and set
  `AI_BASE_URL` to its OpenAI-compatible endpoint, e.g.
  `http://host:11434/v1` (example — use your host's address), with
  `AI_MODEL` set to a pulled model name. A local endpoint needs no auth:
  `AI_API_KEY` may be unset or any dummy value; no Authorization header is
  sent when it is empty.
- **Cloudflare Workers AI (the Cloudflare deployment path)** — Cloudflare's
  own models are reachable through an OpenAI-compatible endpoint, so no code
  change is needed. Set:
  - `AI_BASE_URL` to
    `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`
    (replace `<ACCOUNT_ID>` with the Cloudflare account id; the server
    appends `/chat/completions`).
  - `AI_MODEL` to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (text: grading
    suggestions + assessment generation).
  - `AI_VISION_MODEL` to `@cf/meta/llama-3.2-11b-vision-instruct` (vision:
    handwritten-paper OCR, curriculum-page OCR, paper matching).
    Restored 2026-10-29: on an agreement error the server now
    submits the documented `{"prompt": "agree"}` form with the
    Worker's own Workers-AI-scoped key, then retries once (see
    `src/server/handwritten.ts`). Earlier chat-message agrees
    (Playground + server) all failed. LLaVA (the 2026-10-29 switch)
    stays in code as the fallback — it answers but cannot read
    handwriting (returned "..." then "[unclear]" live).
  - Dense pages: the provider enforces a ~120s per-call budget
    (HTTP 408, code 3046 — unchangeable from the client). Both the
    handwritten and generate client flows fall back on 408/timeout
    to transcribing overlapping quarters (0–30%, 25–55%, 50–80%,
    75–100%) and joining them with overlap dedup; paper-matching
    is excluded (matching needs whole pages). Halves (0–55%,
    45–100%) were tried first and proved insufficient live
    2026-10-29: the dense Arabic page still exceeded the budget.
  - `AI_API_KEY` to a Cloudflare API token with Account > Workers AI > Read
    permission, set as a Worker secret — never in code or in wrangler.jsonc.
  These model ids come from Cloudflare's Workers AI catalog; confirm they
  are still listed before deploying, and live-test both before relying on
  them: Arabic grading quality, strict-JSON output, and Arabic handwriting
  OCR are NOT proven for these models yet — the pilot smoke tests in
  docs/cloudflare-deploy.md exist for exactly that. Workers AI free-tier
  limits (reported as 10,000 neurons/day by third parties, not confirmed
  against Cloudflare's own pricing page here) must be checked in the
  Cloudflare dashboard before any real usage. Note: a local Ollama endpoint
  does NOT work from a Cloudflare Worker (the edge cannot reach your
  laptop's localhost) unless exposed through a Cloudflare Tunnel.

Example values in this document are examples to verify, not guarantees:
free tiers change models, limits, and availability without notice, and a
self-hosted model needs a machine with enough RAM/VRAM for the model size.

## Notes that always apply, whatever the model

- **Free hosted tiers have rate limits.** If the provider returns 429 or
  timeouts, the UI surfaces an "AI failed" error (not a silent failure) and
  the teacher can retry or grade manually. Nothing is ever auto-submitted.
- **Teacher-final-word stays in place regardless of model.** AI output is
  always a draft: suggestions must be accepted/edited/rejected by the
  teacher, generated assessments are saved as unpublished drafts, and the
  grading release gate (every question needs a teacher score) is unchanged.
  A weaker free model just means the teacher edits more — it never changes
  a final score by itself.
- **Quality varies by model.** Smaller/cheaper models may produce weaker
  Arabic feedback or invalid JSON; both features validate the model's
  output defensively and fail with a clear error rather than saving bad
  data.

## Handwritten paper grading (OCR) — needs a vision-capable model

The `/handwritten` page sends the paper photo to the vision model
through the native Workers AI run endpoint. Chat-capable vision
models take a messages payload; image-to-text models (LLaVA
fallback) take a byte-array image + text prompt and answer in
`result.description` — see `runImageToTextModel` in
`src/server/handwritten.ts`, shared by handwritten OCR, source OCR,
and paper matching. One extra server-side variable controls which
model reads the photos:

| Variable          | Required | Meaning |
| ----------------- | -------- | ------- |
| `AI_VISION_MODEL` | When `AI_MODEL` can't read images | Vision-capable model for OCR. When unset, `AI_MODEL` is used — and if that model rejects image input, the page shows a clear "model does not support images" error instead of failing silently. |

Honest limits, stated in the UI too: Arabic handwriting OCR is
approximate, so the page forces a human review step on the INPUT side —
the extracted text is editable and the teacher reviews it before
grading. The grade itself, however, is set by the AI: the suggestion
score is adopted as the final score on save. That is a user-directed
exception to the teacher-final-word rule that applies on `/grading`
(where the teacher approves or edits every suggestion); a wrong
handwritten record can be deleted from the page's history and re-graded
(deleting also removes its stored paper, best-effort).

PLATFORM RULE: every uploaded photo is persisted server-side. Papers
are stored in the private Supabase Storage bucket `handwritten-papers`
under `{teacher_id}/{uuid}.jpg` (see
`supabase/migrations/20261027020000_handwritten_storage.sql` for the
bucket and the folder-based RLS policies), and the saved grade row
links to its paper through `image_path`. History re-opens papers via
time-limited signed URLs — never public links, never browser-only
memory. The extracted text, the teacher-corrected text, the AI
suggestion, and the final grade are saved alongside the path (see
`supabase/migrations/20261027010000_handwritten_grades.sql`).
Free-tier vision availability changes often — verify in your provider
account that the chosen model accepts image input before relying on it.

## Future fine-tuning dataset (not built yet)

Every accepted or edited AI grading suggestion is logged (anonymized) to
the `ai_training_examples` table: question text, rubric, student answer,
the AI's suggested score/feedback, and the teacher's final score/feedback
side by side — with **no student, teacher, or school identifiers**. The
intent is a future fine-tuning phase (e.g. LoRA on an Arabic-capable open
model). That phase is NOT built: before any training use, the dataset must
be used only with proper consent, and free-text answers must be scrubbed
for personal data (a student could have typed a name into an answer).
See the comment in `src/server/ai-grade.ts` (`logAiTrainingExample`).

## Phase 2 — generation from files and images

The generate page accepts three source kinds, all landing in the source
textarea for teacher review before generation (never generated from
raw extraction):

- PDF: parsed in the browser with pdfjs-dist (dynamically imported).
- Word (.docx): parsed in the browser with mammoth (dynamically
  imported). Legacy .doc binaries are not supported.
- Curriculum page photos (up to 5): compressed to ≤1600px JPEG, saved
  to the private `generation-sources` bucket, then OCR'd by the vision
  server function `src/server/source-ocr.ts`, which reuses the same
  vision config and error codes as handwritten OCR
  (`AI_VISION_MODEL`, else `AI_MODEL`; `VISION_NOT_CONFIGURED` /
  `VISION_UNSUPPORTED` / `VISION_TIMEOUT` / `VISION_UPSTREAM` /
  `VISION_PARSE_FAILED`).

Every uploaded source file is persisted server-side first (platform
rule), under `{teacher_id}/{uuid}.{ext}` with folder-based RLS (see
`supabase/migrations/20261027040000_phase2_generation.sql`). Source
text is capped at 30,000 characters (raised from 12,000 for full
chapters); longer input is blocked in the UI rather than silently
truncated.

Difficulty: the generator assigns each question `easy`, `medium`, or
`hard` (stored on `questions.difficulty`, editable in the builder).
The teacher picks `mixed` (the model varies levels) or one level for
the whole draft. Invalid model values fall back to `medium` in
`parseGeneratedDraft`, never dropped.

Question bank: the builder lists the teacher's own earlier questions
(RLS-scoped) and copies a selected question + its key into the
current assessment. Copies are new rows — editing a copy never
affects the original assessment.

## Phase 2 follow-up — English OCR (Phase 3)

Both vision prompts (handwritten OCR and source OCR) now carry an
explicit language-preservation line: "If the page is in English,
transcribe it in English; if in Arabic, in Arabic — never translate."
The same vision model and endpoint serve both languages; nothing
language-specific is configured server-side. Pilot checklist (not yet
run): upload one English handwritten page and one English printed
page, and verify the transcription keeps the original language and
the matching step (Phase 3) assigns them to the right questions.

## Phase 3 — Arabic AI correction depth

### Smart question-matching (`src/server/paper-matching.ts`)

With an assessment selected, the teacher uploads up to 10 page
photos (each saved to the private `handwritten-papers` bucket on
select, same platform rule as single photos). Matching runs
cheapest-signal-first per page:

1. NUMBER: the vision call transcribes the page and reports the
   question number visible on it (digits, Western or Arabic-Indic).
   A number inside the assessment's range matches directly
   (confidence high). Ordinal words (الثالث) are not parsed and fall
   through.
2. AI: a text-model call compares the transcribed answer against the
   assessment's numbered question list and returns an index plus
   high/medium/low confidence, or null.
3. NONE: the teacher picks the question manually in the UI.

Matched pages prefill the EXISTING single-grade form (question,
photo, text) — there is no second grading path, and the AI-final
rule for handwritten grades is unchanged. Vision failures stop the
batch with a page index (retry that page alone); text-match failures
degrade to "none" per page, never failing the batch.

### Unclear-part flagging (`src/lib/uncertain-text.ts`)

The handwritten OCR prompt asks the model to wrap text it reads with
difficulty in ⟦ ⟧ markers (fully unreadable parts stay [غير واضح]).
The review UI highlights those spans and counts them, labeled
honestly as the model's own estimates — NOT a measured confidence
score (the OpenAI-compatible API returns no per-token confidence).
Parsing is conservative: unclosed markers render as plain text and
empty pairs are dropped. Source OCR does NOT use these markers (they
would flow into generation input); it keeps the language line only.

### Similar-answer grouping (`src/lib/similar-answers.ts`)

Pure client-side clustering over already-saved corrected answers,
per question: Arabic-aware normalization (diacritics/tatweel stripped,
alef forms unified, ى→ي, ة→ه), stopword removal, Jaccard similarity
on token sets, greedy clustering at a 0.55 threshold, groups of 2+
shown in history with scores side by side. The UI labels this
neutrally — similarity is a review aid for inconsistent grading, never
evidence of copying. No migration was needed for Phase 3: matching,
markers, and grouping all work on existing tables and buckets.

## Assessment generation: failure codes (`/assessments/generate`)

Generation used to `throw` a plain Error whose only content was a code
(`AI_UPSTREAM`), and a thrown server-fn error is re-serialised by the
framework in production — so the teacher saw a button that "did nothing".
`src/lib/generate-assessment.ts` now RETURNS a discriminated result
(`{ ok: true, ... }` or `{ ok: false, code, detail }`, taxonomy in
`src/lib/ai-failure.ts`), and the page keeps it in a persistent panel:

| Code                | Meaning                                                      | Fix |
| ------------------- | ------------------------------------------------------------ | --- |
| `AI_NOT_CONFIGURED` | `AI_BASE_URL`/`AI_MODEL` missing, or hosted URL with no key   | set the vars/secret |
| `AI_AUTH`           | provider returned 401/403                                     | `AI_API_KEY` wrong or missing Workers AI permission |
| `AI_RATE_LIMIT`     | provider returned 429                                         | Workers AI daily quota / retry later |
| `AI_BAD_REQUEST`    | provider returned 400/404/405/422                             | usually a wrong `AI_MODEL` id |
| `AI_UPSTREAM`       | 5xx or transport failure (detail carries the cause)           | retry; check provider status |
| `AI_TIMEOUT`        | no reply within 120 s                                         | shorter source text; retry |
| `AI_EMPTY_REPLY`    | 200 with empty content (detail carries `finish_reason`)       | retry with shorter text |
| `AI_PARSE_FAILED`   | reply had no usable JSON/questions (detail carries its head)   | retry; shorter/cleaner source |
| `DB_ERROR`          | Supabase insert failed (detail carries the row/column error)   | RLS or schema problem |
| `NOT_TEACHER`       | caller role is not school_teacher/tutor                       | expected |
| `VALIDATION`        | payload rejected (source < 50 chars, no type, bad count)      | expected |

Two hardening changes ship with it:

1. `max_tokens: 4096` is now sent explicitly. Without it the provider's
   implicit output cap applied and a multi-question JSON reply was cut off
   mid-array — the request "succeeded", nothing was saved.
2. `extractJsonObject()` repairs a truncated reply (keeps every question
   object that arrived complete, closes the array/object) instead of
   failing the whole generation; a missing model `title` no longer
   discards a valid question set (the teacher's title is used instead).
