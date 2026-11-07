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
    handwritten-paper OCR).
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

The `/handwritten` page sends the paper photo to the same OpenAI-compatible
endpoint as a multimodal chat completion (text + image). One extra
server-side variable controls which model reads the photos:

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
