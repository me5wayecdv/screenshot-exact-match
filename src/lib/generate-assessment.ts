// Server function for assessment generation (slice 2) — D1 port
// (Phase 2b). Behavior preserved from the Supabase original; only the
// auth, quota, usage, and draft-persistence plumbing changed:
//
// - Auth: the session is resolved server-side from the HttpOnly cookie
//   by requireCloudflareAuth. No token is sent by the client.
// - Role gate: school_teacher + tutor only (legacy "teacher" rows map
//   to school_teacher). Admin is NOT a generator here, same as before.
// - Subject lookup: by id, no ownership filter (subjects are names,
//   not student data — same as the original).
// - Quota: D1 consumeAiQuota, units = ceil(questionCount / 5).
// - Usage: D1 logAiUsageEvent (token counts + model only).
// - Draft persistence: the existing D1 saver saveGeneratedDraft()
//   (src/server/d1-generation.ts) REPLACES the original's per-question
//   Supabase inserts — one saver, never two, so no double draft.
//   Difference to note: the saver inserts the whole draft in one
//   batch, where the original inserted question-by-question and could
//   leave a partial draft on a mid-loop failure. The batch is strictly
//   safer (all-or-nothing), and the draft is still UNPUBLISHED either
//   way — the teacher reviews/edits it in the builder before publish.
//   The saver also preserves each question's objective (Phase 2b).
//
// Teacher-final-word: the saved assessment has status "draft" and is
// NEVER published here. The teacher reviews/edits it in the existing
// builder route (/assessments/$id) and publishes from there.

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { consumeAiQuota, logAiUsageEvent } from "@/server/d1-quota";
import { resolveAiConfig } from "@/server/ai-config";
import { extractOpenAiUsage, openAiProvider } from "@/server/ai-usage";
import { saveGeneratedDraft, GenerationError } from "@/server/d1-generation";
import {
  buildGeneratePrompt,
  distributeCounts,
  extractJsonObject,
  isGenerateDifficulty,
  isGenerateQuestionType,
  parseGeneratedDraft,
  type GenerateDifficulty,
  type GenerateQuestionType,
  type GeneratedDraft,
} from "./generate-assessment-prompt";
import {
  classifyAiHttpStatus,
  describeProviderError,
  describeThrown,
  type GenerateFailureCode,
} from "./ai-failure";

export type GenerateAssessmentInput = {
  /** Teacher-provided title; blank => the model's title is used. */
  title: string;
  subjectId: string | null;
  gradeLevel: string;
  /** Pasted chapter/lesson text, or text extracted from an uploaded
   *  file/image (the generate page extracts before calling; this
   *  function still only ever receives plain text). */
  sourceText: string;
  questionCount: number;
  types: GenerateQuestionType[];
  /** Difficulty preference: one level, or "mixed" (default). */
  difficulty: GenerateDifficulty;
};

export type GenerateAssessmentSuccess = {
  ok: true;
  assessmentId: string;
  title: string;
  /** Questions actually saved (<= requestedCount when some were invalid
   *  or the reply was truncated). */
  questionCount: number;
  /** Questions the teacher asked for — the UI must say so explicitly when
   *  fewer were saved, never present a partial draft as complete. */
  requestedCount: number;
};

export type GenerateAssessmentFailure = {
  ok: false;
  /** Stable code shown verbatim in the page's persistent error panel. */
  code: GenerateFailureCode;
  /** Non-secret diagnostic detail (HTTP status / provider message head). */
  detail: string;
};

export type GenerateAssessmentResult = GenerateAssessmentSuccess | GenerateAssessmentFailure;

const AI_TIMEOUT_MS = 120_000;
const SOURCE_MIN_CHARS = 50;
/** Raised from 12,000 in Phase 2: file/image sources (a full chapter)
 *  legitimately exceed the paste-only budget; 30,000 chars (~8k tokens)
 *  still fits comfortably in the models' context windows. */
const SOURCE_MAX_CHARS = 30_000;

/** Validate the untrusted client payload. Throws Error("VALIDATION"). */
function validateGenerateInput(data: unknown): GenerateAssessmentInput {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("VALIDATION");
  }
  const d = data as Record<string, unknown>;
  // Strip C0 control characters (except tab/newline/CR) and DEL at the
  // boundary: PDF text extraction (pdfjs) emits form feeds and similar
  // bytes, and the model echoes them raw into its JSON reply, which used
  // to make the reply unparseable (AI_PARSE_FAILED).
  const sourceText = (typeof d["sourceText"] === "string" ? d["sourceText"] : "")
    // eslint-disable-next-line no-control-regex -- deliberately strip disallowed C0 bytes from extracted source text.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
  if (sourceText.length < SOURCE_MIN_CHARS) throw new Error("VALIDATION");
  const types = Array.isArray(d["types"])
    ? [...new Set(d["types"].filter(isGenerateQuestionType))]
    : [];
  if (types.length === 0) throw new Error("VALIDATION");
  const rawCount = typeof d["questionCount"] === "number" ? d["questionCount"] : NaN;
  if (!Number.isFinite(rawCount)) throw new Error("VALIDATION");
  return {
    title: typeof d["title"] === "string" ? d["title"].trim().slice(0, 200) : "",
    subjectId: typeof d["subjectId"] === "string" && d["subjectId"] ? d["subjectId"] : null,
    gradeLevel: typeof d["gradeLevel"] === "string" ? d["gradeLevel"].trim().slice(0, 60) : "",
    sourceText: sourceText.slice(0, SOURCE_MAX_CHARS),
    questionCount: Math.min(20, Math.max(1, Math.floor(rawCount))),
    types,
    difficulty: isGenerateDifficulty(d["difficulty"]) ? d["difficulty"] : "mixed",
  };
}

type AiChatResponse = {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

/**
 * Output-token budget for the reply. The OpenAI-compatible request used to
 * omit max_tokens entirely, so the provider's implicit cap applied and a
 * multi-question JSON reply was cut off mid-array (valid questions lost,
 * nothing saved, no message). 4,096 tokens comfortably holds 20 questions
 * with Arabic text, and extractJsonObject()'s repair path keeps a partially
 * arrived reply usable if the provider still cuts earlier.
 */
const AI_MAX_TOKENS = 4096;

/** Neutral title when neither the teacher nor the model supplies one. */
const FALLBACK_TITLE = "اختبار مولَّد";

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

export const generateAssessment = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }): Promise<GenerateAssessmentResult> => {
    // Failures are RETURNED, never thrown: a thrown error is re-serialised
    // by the framework in production and the teacher sees a dead button
    // with no diagnosis. Every branch below names its cause.
    const fail = (code: GenerateFailureCode, detail = ""): GenerateAssessmentFailure => {
      if (code !== "VALIDATION") console.error(`[generate] ${code}${detail ? `: ${detail}` : ""}`);
      return { ok: false, code, detail };
    };

    let input: GenerateAssessmentInput;
    try {
      input = validateGenerateInput(data);
    } catch {
      return fail("VALIDATION");
    }

    const session = ctxSession(context);
    const db = ctxDb(context);
    const userId = session.userId;

    // Role gate: teachers only (school_teacher + tutor; legacy "teacher"
    // rows map to school_teacher, mirroring src/lib/session.ts).
    const role = (session.role as string) === "teacher" ? "school_teacher" : session.role;
    if (role !== "school_teacher" && role !== "tutor") return fail("NOT_TEACHER");

    // Optional subject link: must exist (subjects are names, not
    // student data, so no ownership filter — same as the original).
    let subjectName: string | null = null;
    if (input.subjectId) {
      const subj = await db
        .prepare("SELECT id, name FROM subjects WHERE id = ?")
        .bind(input.subjectId)
        .first<{ id: string; name: string }>();
      if (!subj) return fail("VALIDATION", "SUBJECT_NOT_VISIBLE");
      subjectName = subj.name;
    }

    // AI provider check BEFORE any AI call or DB write: an unconfigured
    // provider is a configuration state, not a silent failure.
    const aiConfig = resolveAiConfig();
    if (!aiConfig) return fail("AI_NOT_CONFIGURED");
    if (!(await consumeAiQuota(db, userId, Math.ceil(input.questionCount / 5)))) {
      return fail("AI_RATE_LIMIT");
    }
    const { baseUrl, model, apiKey } = aiConfig;

    const counts = distributeCounts(input.questionCount, input.types);
    const prompt = buildGeneratePrompt({
      sourceText: input.sourceText,
      subjectName,
      gradeLevel: input.gradeLevel,
      counts,
      difficulty: input.difficulty,
    });

    // OpenAI-compatible chat completions call. response_format is
    // deliberately NOT requested: it is OpenAI-specific and would break
    // other OpenAI-compatible endpoints behind AI_BASE_URL; the prompt
    // demands JSON-only output and extractJsonObject() tolerates fences.
    let replyText = "";
    let finishReason = "";
    try {
      // No Authorization header when the key is empty (local endpoints
      // without auth, e.g. Ollama).
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: AI_MAX_TOKENS,
          messages: [
            {
              role: "system",
              content:
                "You generate assessments from curriculum text. Reply with JSON only, no markdown fences, no extra text.",
            },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      if (!res.ok) {
        // Read the provider body (capped, message field only) so the code
        // shown to the teacher is actionable: wrong key, quota, bad model.
        let detail = "";
        try {
          detail = describeProviderError(await res.json());
        } catch {
          detail = "";
        }
        return fail(
          classifyAiHttpStatus(res.status),
          `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
        );
      }
      const json = (await res.json()) as AiChatResponse;
      replyText = json.choices?.[0]?.message?.content ?? "";
      finishReason =
        (json as { choices?: { finish_reason?: string }[] }).choices?.[0]?.finish_reason ?? "";
      if (!replyText.trim()) {
        return fail("AI_EMPTY_REPLY", finishReason ? `finish_reason=${finishReason}` : "");
      }
      // Pilot cost measurement (best-effort, never fails generation):
      // one row per successful generation call, attributed to the teacher.
      const usage = extractOpenAiUsage(json);
      await logAiUsageEvent(db, userId, {
        kind: "generate",
        provider: openAiProvider(baseUrl),
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }).catch(() => undefined);
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError") return fail("AI_TIMEOUT");
      return fail("AI_UPSTREAM", describeThrown(e));
    }

    // Defensive parse: drops unusable questions; fails cleanly (before
    // any DB write) if nothing valid survives.
    let draft: GeneratedDraft;
    try {
      draft = parseGeneratedDraft(extractJsonObject(replyText), input.questionCount);
    } catch (e) {
      // Bounded, content-free diagnostics only: reply length, provider
      // finish_reason and the first JSON parse offset. The raw reply can
      // carry private lesson/student content and is never echoed to the
      // UI or the logs.
      const pos = e instanceof Error ? / at position (\d+)$/.exec(e.message)?.[1] : undefined;
      return fail(
        "AI_PARSE_FAILED",
        [
          `replyLen=${replyText.length}`,
          finishReason ? `finish=${finishReason}` : "",
          pos ? `parseErrorAt=${pos}` : "",
        ]
          .filter(Boolean)
          .join("; "),
      );
    }

    // Save as an UNPUBLISHED draft owned by the teacher via the single
    // D1 draft saver — no second draft path, no assignments, no
    // submissions, no publish step here.
    let saved: { assessmentId: string; questionCount: number };
    try {
      saved = await saveGeneratedDraft(
        db,
        { id: userId, role },
        {
          title: input.title || draft.title || FALLBACK_TITLE,
          subjectId: input.subjectId,
          gradeLevel: input.gradeLevel,
          questions: draft.questions.map((q) => ({
            type: q.type,
            prompt: q.prompt,
            options: q.options,
            marks: q.marks,
            difficulty: q.difficulty,
            objective: q.objective,
            correctAnswer: q.correct_answer,
            acceptedAlternatives: q.accepted_alternatives,
            rubric: q.rubric,
            explanation: q.explanation,
          })),
        },
      );
    } catch (e) {
      if (e instanceof GenerationError) return fail("DB_ERROR", e.code);
      return fail("DB_ERROR", describeThrown(e));
    }

    return {
      ok: true,
      assessmentId: saved.assessmentId,
      title: input.title || draft.title || FALLBACK_TITLE,
      questionCount: saved.questionCount,
      requestedCount: input.questionCount,
    };
  });
