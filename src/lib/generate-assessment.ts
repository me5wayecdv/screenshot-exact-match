// Server function for assessment generation (slice 2).
//
// Pattern (already established in this repo, NOT invented here):
// - src/start.ts registers attachSupabaseAuth as a global client
//   functionMiddleware, so the browser attaches the Supabase Bearer token
//   to serverFn RPCs.
// - src/integrations/supabase/auth-middleware.ts exports
//   requireSupabaseAuth, a server functionMiddleware that validates that
//   token and puts { supabase, userId, claims } on the handler context.
//   `supabase` there is an RLS-scoped client for the calling user, so
//   all writes below obey the same policies as the existing client-side
//   assessment create (src/routes/_authenticated/assessments.index.tsx).
//
// Env (server-side ONLY — never read these on the client, never hardcode
// a key, no provider hardcoded):
// - AI_BASE_URL  (required) Base URL of an OpenAI-compatible API.
// - AI_MODEL     (required) Model name, as the provider expects it. No
//                 default is hardcoded: the deployer picks the model via
//                 env, so a free/open model can be used without a code
//                 change. See docs/ai-models.md for free/open options
//                 (OpenRouter free tier, Groq free tier, Hugging Face
//                 Inference, self-hosted Ollama).
// - AI_API_KEY   (required for hosted providers; optional for local
//                 endpoints) Sent as a Bearer token when set; a local
//                 endpoint without auth works with it unset or dummy.
//
// NOTE on .validator(): intentionally NOT used. The handler hand-validates
// its unknown `data` payload (validateGenerateInput) so this file does not
// depend on a validator-API detail of the installed TanStack Start version.
// The coordinator should confirm .middleware([...]) + handler context
// typing at merge time (see NOTES.md "Unverified").
//
// Teacher-final-word: the saved assessment has status "draft" and is
// NEVER published here. The teacher reviews/edits it in the existing
// builder route (/assessments/$id) and publishes from there.

import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveAiConfig } from "@/server/ai-config";
import { extractOpenAiUsage, logAiUsage, openAiProvider } from "@/server/ai-usage";
import type { Database } from "@/integrations/supabase/types";
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
  questionCount: number;
};

export type GenerateAssessmentFailure = {
  ok: false;
  /** Stable code shown verbatim in the page's persistent error panel. */
  code: GenerateFailureCode;
  /** Non-secret diagnostic detail (HTTP status / provider message head). */
  detail: string;
};

export type GenerateAssessmentResult = GenerateAssessmentSuccess | GenerateAssessmentFailure;

type AuthedContext = {
  userId: string;
  supabase: SupabaseClient<Database>;
};

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
  const sourceText = typeof d["sourceText"] === "string" ? d["sourceText"].trim() : "";
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

export const generateAssessment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
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

    // requireSupabaseAuth puts userId + an RLS-scoped supabase client on
    // context. The cast is defensive: if the installed TanStack version
    // infers the middleware context, the coordinator can drop it.
    const authed = context as unknown as Partial<AuthedContext>;
    const userId = authed.userId ?? "";
    const supabase = authed.supabase as SupabaseClient<Database> | undefined;
    if (!userId || !supabase) return fail("NOT_TEACHER");

    // Role gate: teachers only (school_teacher + tutor; legacy "teacher"
    // rows map to school_teacher, mirroring src/lib/session.ts).
    const { data: roleRow, error: roleErr } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    if (roleErr) return fail("DB_ERROR", describeThrown(roleErr));
    const rawRole = roleRow?.role as string | undefined;
    const role = rawRole === "teacher" ? "school_teacher" : rawRole;
    if (role !== "school_teacher" && role !== "tutor") return fail("NOT_TEACHER");

    // Optional subject link: must exist and be visible to this teacher
    // (RLS hides other teachers' subjects, so a foreign id fails here).
    let subjectName: string | null = null;
    if (input.subjectId) {
      const { data: subj, error } = await supabase
        .from("subjects")
        .select("id, name")
        .eq("id", input.subjectId)
        .maybeSingle();
      if (error || !subj) return fail("VALIDATION", "SUBJECT_NOT_VISIBLE");
      subjectName = subj.name;
    }

    // AI provider check BEFORE any AI call or DB write: an unconfigured
    // provider is a configuration state, not a silent failure.
    const aiConfig = resolveAiConfig();
    if (!aiConfig) return fail("AI_NOT_CONFIGURED");
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
      if (!replyText.trim()) {
        const finish = (json as { choices?: { finish_reason?: string }[] }).choices?.[0]
          ?.finish_reason;
        return fail("AI_EMPTY_REPLY", finish ? `finish_reason=${finish}` : "");
      }
      // Pilot cost measurement (best-effort, never fails generation):
      // one row per successful generation call, attributed to the teacher.
      await logAiUsage(supabase, userId, {
        kind: "generate",
        provider: openAiProvider(baseUrl),
        model,
        usage: extractOpenAiUsage(json),
      });
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
    } catch {
      // Ship the head of the reply so the failure is diagnosable from the
      // error panel instead of "something went wrong".
      return fail("AI_PARSE_FAILED", `reply: ${describeThrown(replyText, 160)}`);
    }

    // Save as an UNPUBLISHED draft owned by the teacher. No assignments,
    // no submissions, no publish step here.
    const { data: assessment, error: aErr } = await supabase
      .from("assessments")
      .insert({
        title: input.title || draft.title || FALLBACK_TITLE,
        teacher_id: userId,
        subject_id: input.subjectId,
        grade_level: input.gradeLevel,
        instructions: "",
        status: "draft",
      })
      .select("id, title")
      .single();
    if (aErr || !assessment) return fail("DB_ERROR", describeThrown(aErr));

    // Questions are inserted one by one (max 20) so each returned id can
    // be paired with its question_keys row. If a later insert fails, the
    // draft stays a draft with the questions saved so far — the teacher
    // can fix or delete them in the builder; nothing is ever published
    // automatically, so a partial draft is safe but visible (see NOTES).
    for (let i = 0; i < draft.questions.length; i++) {
      const q = draft.questions[i]!;
      const { data: saved, error: qErr } = await supabase
        .from("questions")
        .insert({
          assessment_id: assessment.id,
          type: q.type,
          position: i,
          prompt: q.prompt,
          marks: q.marks,
          objective: q.objective,
          options: q.options,
          difficulty: q.difficulty,
        })
        .select("id")
        .single();
      if (qErr || !saved) {
        return fail("DB_ERROR", `questions insert #${i + 1}: ${describeThrown(qErr)}`);
      }
      const { error: kErr } = await supabase.from("question_keys").insert({
        question_id: saved.id,
        correct_answer: q.correct_answer,
        accepted_alternatives: q.accepted_alternatives,
        rubric: q.rubric,
        explanation: q.explanation,
      });
      if (kErr) {
        return fail("DB_ERROR", `question_keys insert #${i + 1}: ${describeThrown(kErr)}`);
      }
    }

    return {
      ok: true,
      assessmentId: assessment.id,
      title: assessment.title,
      questionCount: draft.questions.length,
    };
  });
