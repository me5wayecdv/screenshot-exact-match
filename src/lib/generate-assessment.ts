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
import type { Database } from "@/integrations/supabase/types";
import {
  buildGeneratePrompt,
  distributeCounts,
  extractJsonObject,
  isGenerateQuestionType,
  parseGeneratedDraft,
  type GenerateQuestionType,
} from "./generate-assessment-prompt";

export type GenerateAssessmentInput = {
  /** Teacher-provided title; blank => the model's title is used. */
  title: string;
  subjectId: string | null;
  gradeLevel: string;
  /** Pasted chapter/lesson text ONLY (V1 scope — no PDF parsing). */
  sourceText: string;
  questionCount: number;
  types: GenerateQuestionType[];
};

export type GenerateAssessmentResult = {
  assessmentId: string;
  title: string;
  questionCount: number;
};

type AuthedContext = {
  userId: string;
  supabase: SupabaseClient<Database>;
};

const AI_TIMEOUT_MS = 120_000;
const SOURCE_MIN_CHARS = 50;
const SOURCE_MAX_CHARS = 12_000;

/** Validate the untrusted client payload. Throws Error("VALIDATION"). */
function validateGenerateInput(data: unknown): GenerateAssessmentInput {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("VALIDATION");
  }
  const d = data as Record<string, unknown>;
  const sourceText = typeof d.sourceText === "string" ? d.sourceText.trim() : "";
  if (sourceText.length < SOURCE_MIN_CHARS) throw new Error("VALIDATION");
  const types = Array.isArray(d.types) ? [...new Set(d.types.filter(isGenerateQuestionType))] : [];
  if (types.length === 0) throw new Error("VALIDATION");
  const rawCount = typeof d.questionCount === "number" ? d.questionCount : NaN;
  if (!Number.isFinite(rawCount)) throw new Error("VALIDATION");
  return {
    title: typeof d.title === "string" ? d.title.trim().slice(0, 200) : "",
    subjectId: typeof d.subjectId === "string" && d.subjectId ? d.subjectId : null,
    gradeLevel: typeof d.gradeLevel === "string" ? d.gradeLevel.trim().slice(0, 60) : "",
    sourceText: sourceText.slice(0, SOURCE_MAX_CHARS),
    questionCount: Math.min(20, Math.max(1, Math.floor(rawCount))),
    types,
  };
}

type AiChatResponse = {
  choices?: { message?: { content?: string | null } }[];
};

export const generateAssessment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }): Promise<GenerateAssessmentResult> => {
    const input = validateGenerateInput(data);
    // requireSupabaseAuth puts userId + an RLS-scoped supabase client on
    // context. The cast is defensive: if the installed TanStack version
    // infers the middleware context, the coordinator can drop it.
    const { userId, supabase } = context as unknown as AuthedContext;
    if (!userId) throw new Error("NOT_TEACHER");

    // Role gate: teachers only (school_teacher + tutor; legacy "teacher"
    // rows map to school_teacher, mirroring src/lib/session.ts).
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    const rawRole = roleRow?.role as string | undefined;
    const role = rawRole === "teacher" ? "school_teacher" : rawRole;
    if (role !== "school_teacher" && role !== "tutor") {
      throw new Error("NOT_TEACHER");
    }

    // Optional subject link: must exist and be visible to this teacher
    // (RLS hides other teachers' subjects, so a foreign id fails here).
    let subjectName: string | null = null;
    if (input.subjectId) {
      const { data: subj, error } = await supabase
        .from("subjects")
        .select("id, name")
        .eq("id", input.subjectId)
        .maybeSingle();
      if (error || !subj) throw new Error("VALIDATION");
      subjectName = subj.name;
    }

    // AI provider check BEFORE any AI call or DB write: an unconfigured
    // provider is a configuration state, not a silent failure.
    const aiConfig = resolveAiConfig();
    if (!aiConfig) throw new Error("AI_NOT_CONFIGURED");
    const baseUrl = aiConfig.baseUrl;
    const model = aiConfig.model;
    const apiKey = aiConfig.apiKey;

    const counts = distributeCounts(input.questionCount, input.types);
    const prompt = buildGeneratePrompt({
      sourceText: input.sourceText,
      subjectName,
      gradeLevel: input.gradeLevel,
      counts,
    });

    // OpenAI-compatible chat completions call. response_format is
    // deliberately NOT requested: it is OpenAI-specific and would break
    // other OpenAI-compatible endpoints behind AI_BASE_URL; the prompt
    // demands JSON-only output and extractJsonObject() tolerates fences.
    let replyText: string;
    try {
      // No Authorization header when the key is empty (local endpoints
      // without auth, e.g. Ollama).
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          temperature: 0.3,
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
      if (!res.ok) throw new Error("AI_UPSTREAM");
      const json = (await res.json()) as AiChatResponse;
      replyText = json.choices?.[0]?.message?.content ?? "";
      if (!replyText.trim()) throw new Error("AI_PARSE_FAILED");
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new Error("AI_TIMEOUT");
      }
      if (e instanceof Error && ["AI_UPSTREAM", "AI_PARSE_FAILED"].includes(e.message)) throw e;
      throw new Error("AI_UPSTREAM");
    }

    // Defensive parse: drops unusable questions; fails cleanly (before
    // any DB write) if nothing valid survives.
    let draft;
    try {
      draft = parseGeneratedDraft(extractJsonObject(replyText), input.questionCount);
    } catch {
      throw new Error("AI_PARSE_FAILED");
    }

    // Save as an UNPUBLISHED draft owned by the teacher. No assignments,
    // no submissions, no publish step here.
    const { data: assessment, error: aErr } = await supabase
      .from("assessments")
      .insert({
        title: input.title || draft.title,
        teacher_id: userId,
        subject_id: input.subjectId,
        grade_level: input.gradeLevel,
        instructions: "",
        status: "draft",
      })
      .select("id, title")
      .single();
    if (aErr || !assessment) throw aErr ?? new Error("DB_ERROR");

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
        })
        .select("id")
        .single();
      if (qErr || !saved) throw qErr ?? new Error("DB_ERROR");
      const { error: kErr } = await supabase.from("question_keys").insert({
        question_id: saved.id,
        correct_answer: q.correct_answer,
        accepted_alternatives: q.accepted_alternatives,
        rubric: q.rubric,
        explanation: q.explanation,
      });
      if (kErr) throw kErr;
    }

    return {
      assessmentId: assessment.id,
      title: assessment.title,
      questionCount: draft.questions.length,
    };
  });
