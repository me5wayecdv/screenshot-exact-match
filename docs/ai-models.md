# AI models for Qemmini (grading suggestions + assessment generation)

Both AI features (grading suggestions on `/grading`, assessment generation on
`/assessments/generate`) are **provider-agnostic**: the server calls a plain
OpenAI-compatible `POST /chat/completions` endpoint with `fetch`. There is no
provider-specific SDK and no provider or model hardcoded in code. Everything
is chosen with three server-side environment variables (never `VITE_`):

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
