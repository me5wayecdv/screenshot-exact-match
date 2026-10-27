/**
 * Server functions for AI grading suggestions (slice 1).
 *
 * These run ONLY on the server (TanStack Start server functions). The client
 * imports only the function stubs; the AI key, the prompt call, and the
 * Supabase auth check never ship to the browser.
 *
 * NOTE on repo conventions: at the time of writing, the repo has NO existing
 * server function to copy — all data access goes through the Supabase client
 * from the browser (see src/routes/_authenticated/grading.tsx). So this file
 * introduces the repo's first server function, using the standard
 * `createServerFn` API of the already-installed @tanstack/react-start
 * (v1.168.x). It deliberately does NOT use the installed `ai` / @ai-sdk
 * packages: plain fetch against an OpenAI-compatible endpoint honours the
 * required AI_API_KEY / AI_BASE_URL / AI_MODEL env names exactly, with any
 * compatible provider, and adds no new dependency.
 *
 * Server environment required (in addition to the AI vars in ai-client.ts):
 *   SUPABASE_URL       (or VITE_SUPABASE_URL as fallback)
 *   SUPABASE_ANON_KEY  (or VITE_SUPABASE_ANON_KEY / VITE_SUPABASE_PUBLISHABLE_KEY)
 * These are needed ONLY to validate the teacher's access token server-side.
 * If they are absent, the function fails closed (UNAUTHORIZED) rather than
 * grading without an auth check.
 *
 * Auth model: the /grading page already gates to school_teacher on the
 * client. This server function re-checks, defence in depth: the client sends
 * its Supabase session access token (obtained via supabase.auth.getSession()
 * — never a stored key), the server validates it with Supabase Auth, requires
 * a teacher/admin role from user_roles, and — when assessmentId is supplied —
 * requires that the assessment belongs to that teacher (admins exempt).
 * A student token, a missing/invalid token, or another teacher's assessment
 * all return UNAUTHORIZED and never reach the AI provider.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { isAiConfigured } from "./ai-config";
import { suggestGradeWithAi, type AiGradeSuggestion } from "./ai-client";

export type AiGradeRequest = {
  questionPrompt: string;
  rubric: string;
  acceptedAlternatives: string[];
  studentAnswer: string;
  maxMarks: number;
  /** Optional: when supplied, ownership is verified server-side. */
  assessmentId?: string;
  /** Supabase session access token from the calling teacher's browser. */
  accessToken: string;
};

export type AiGradeResult =
  | { ok: true; suggestion: AiGradeSuggestion }
  | {
      ok: false;
      code: "INVALID_INPUT" | "UNAUTHORIZED" | "AI_NOT_CONFIGURED" | "AI_ERROR";
      message: string;
    };

const TEACHER_ROLES = new Set(["school_teacher", "tutor", "admin"]);

function serverSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const anonKey =
    process.env.SUPABASE_ANON_KEY?.trim() ||
    process.env.VITE_SUPABASE_ANON_KEY?.trim() ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

function validateRequest(data: unknown): AiGradeRequest | { error: string } {
  if (typeof data !== "object" || data === null) return { error: "Request must be an object." };
  const d = data as Record<string, unknown>;
  const asString = (v: unknown) => (typeof v === "string" ? v : null);
  const questionPrompt = asString(d.questionPrompt);
  const rubric = asString(d.rubric) ?? "";
  const studentAnswer = asString(d.studentAnswer);
  const accessToken = asString(d.accessToken);
  const maxMarks = typeof d.maxMarks === "number" ? d.maxMarks : Number(d.maxMarks);
  const acceptedAlternatives = Array.isArray(d.acceptedAlternatives)
    ? d.acceptedAlternatives.filter((a): a is string => typeof a === "string")
    : [];
  const assessmentId = asString(d.assessmentId) ?? undefined;
  if (!questionPrompt?.trim()) return { error: "questionPrompt is required." };
  if (studentAnswer === null) return { error: "studentAnswer is required." };
  if (!accessToken?.trim()) return { error: "accessToken is required." };
  if (!Number.isFinite(maxMarks) || maxMarks <= 0 || maxMarks > 1000) {
    return { error: "maxMarks must be a positive number." };
  }
  if (
    questionPrompt.length > 20000 ||
    rubric.length > 20000 ||
    studentAnswer.length > 20000 ||
    acceptedAlternatives.length > 50
  ) {
    return { error: "Input exceeds the maximum allowed size." };
  }
  return {
    questionPrompt,
    rubric,
    acceptedAlternatives,
    studentAnswer,
    maxMarks,
    assessmentId,
    accessToken,
  };
}

/** Verify the caller is a teacher/admin and (when given) owns the assessment. */
async function authorize(
  accessToken: string,
  assessmentId: string | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const env = serverSupabaseEnv();
  if (!env) {
    return {
      ok: false,
      message: "Server Supabase environment is not configured.",
    };
  }
  const supabase = createClient(env.url, env.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user) return { ok: false, message: "Invalid or expired session." };

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();
  // Defensive, mirroring src/lib/session.ts: legacy 'teacher' rows count as school_teacher.
  const role = roleRow?.role === "teacher" ? "school_teacher" : roleRow?.role;
  if (!role || !TEACHER_ROLES.has(role)) {
    return { ok: false, message: "Only teachers can request grading suggestions." };
  }
  if (assessmentId && role !== "admin") {
    const { data: assessment } = await supabase
      .from("assessments")
      .select("teacher_id")
      .eq("id", assessmentId)
      .maybeSingle();
    if (!assessment || assessment.teacher_id !== user.id) {
      return { ok: false, message: "This assessment does not belong to the caller." };
    }
  }
  return { ok: true };
}

/**
 * suggestGrade — server function.
 * Call from the client as: suggestGrade({ data: { ...request } })
 * Returns a discriminated result; it never throws for expected failures, so
 * the UI can distinguish "AI not configured" from other errors.
 */
export const suggestGrade = createServerFn({ method: "POST" }).handler(
  async ({ data }): Promise<AiGradeResult> => {
    const request = validateRequest(data);
    if ("error" in request) {
      return { ok: false, code: "INVALID_INPUT", message: request.error };
    }

    // A blank answer needs no AI call: suggest 0 with a low-confidence note.
    // The teacher still decides — this only fills the draft fields.
    if (!request.studentAnswer.trim()) {
      return {
        ok: true,
        suggestion: { suggestedScore: 0, feedback: "", confidence: "low" },
      };
    }

    const auth = await authorize(request.accessToken, request.assessmentId);
    if (!auth.ok) return { ok: false, code: "UNAUTHORIZED", message: auth.message };

    const result = await suggestGradeWithAi({
      questionPrompt: request.questionPrompt,
      rubric: request.rubric,
      acceptedAlternatives: request.acceptedAlternatives,
      studentAnswer: request.studentAnswer,
      maxMarks: request.maxMarks,
    });
    if (!result.ok) {
      return { ok: false, code: result.error.code, message: result.error.message };
    }
    return { ok: true, suggestion: result.suggestion };
  },
);

/**
 * getAiGradingStatus — server function.
 * Call from the client as: getAiGradingStatus({ data: {} })
 * Returns only a boolean. It never reveals the key, the model, or the base
 * URL, so the grading UI can show the "AI not configured" state up front.
 */
export const getAiGradingStatus = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ configured: boolean }> => {
    return { configured: isAiConfigured() };
  },
);

/**
 * FUTURE FINE-TUNING DATASET — logAiTrainingExample.
 *
 * One anonymized row is written to `ai_training_examples` whenever a
 * teacher ACCEPTS or EDITS an AI grading suggestion (never on Reject).
 * Each row pairs the AI's suggestion with the teacher's final values side
 * by side, so the platform accumulates its own training data from day one:
 * question text, rubric, student answer, ai_suggested_score, ai_feedback,
 * teacher_final_score, teacher_feedback, and the model name (from server
 * env, never from the client).
 *
 * ANONYMIZED BY DESIGN: the row stores NO student name, NO student id,
 * NO teacher id, and NO school id — nothing that identifies a person or
 * a school. The server still verifies the caller is a teacher/admin (and
 * owns the assessment when assessmentId is supplied) before inserting,
 * but the identity is used only for that check, never stored.
 *
 * NO TRAINING PIPELINE IS BUILT HERE. The intended later phase is
 * fine-tuning an Arabic-capable open model (e.g. LoRA) on this table.
 * Before any training use, the dataset must be used ONLY with proper
 * consent, and free-text answers must be scrubbed for personal data — a
 * student could have typed a name or other identifying text into an
 * answer, and raw answer text is stored as-is for grading fidelity.
 * Logging failures must never block grading: the client fires this
 * best-effort and ignores errors.
 */
export type AiTrainingExampleInput = {
  questionPrompt: string;
  rubric: string;
  studentAnswer: string;
  aiSuggestedScore: number;
  aiFeedback: string;
  teacherFinalScore: number;
  teacherFeedback: string;
  maxMarks: number;
  /** Optional: when supplied, ownership is verified server-side. */
  assessmentId?: string;
  /** Supabase session access token from the calling teacher's browser. */
  accessToken: string;
};

function validateTrainingInput(data: unknown): AiTrainingExampleInput | { error: string } {
  if (typeof data !== "object" || data === null) return { error: "Request must be an object." };
  const d = data as Record<string, unknown>;
  const asString = (v: unknown) => (typeof v === "string" ? v : null);
  const questionPrompt = asString(d.questionPrompt);
  const rubric = asString(d.rubric) ?? "";
  const studentAnswer = asString(d.studentAnswer);
  const aiFeedback = asString(d.aiFeedback) ?? "";
  const teacherFeedback = asString(d.teacherFeedback) ?? "";
  const accessToken = asString(d.accessToken);
  const aiSuggestedScore = Number(d.aiSuggestedScore);
  const teacherFinalScore = Number(d.teacherFinalScore);
  const maxMarks = Number(d.maxMarks);
  const assessmentId = asString(d.assessmentId) ?? undefined;
  if (!questionPrompt?.trim()) return { error: "questionPrompt is required." };
  if (studentAnswer === null) return { error: "studentAnswer is required." };
  if (!accessToken?.trim()) return { error: "accessToken is required." };
  if (
    !Number.isFinite(aiSuggestedScore) ||
    !Number.isFinite(teacherFinalScore) ||
    !Number.isFinite(maxMarks) ||
    maxMarks <= 0 ||
    teacherFinalScore < 0 ||
    teacherFinalScore > maxMarks
  ) {
    return { error: "Scores are invalid." };
  }
  if (
    questionPrompt.length > 20000 ||
    rubric.length > 20000 ||
    studentAnswer.length > 20000 ||
    aiFeedback.length > 20000 ||
    teacherFeedback.length > 20000
  ) {
    return { error: "Input exceeds the maximum allowed size." };
  }
  return {
    questionPrompt,
    rubric,
    studentAnswer,
    aiSuggestedScore,
    aiFeedback,
    teacherFinalScore,
    teacherFeedback,
    maxMarks,
    assessmentId,
    accessToken,
  };
}

export const logAiTrainingExample = createServerFn({ method: "POST" }).handler(
  async ({ data }): Promise<{ ok: boolean }> => {
    const input = validateTrainingInput(data);
    if ("error" in input) return { ok: false };

    const auth = await authorize(input.accessToken, input.assessmentId);
    if (!auth.ok) return { ok: false };

    const env = serverSupabaseEnv();
    if (!env) return { ok: false };
    const supabase = createClient(env.url, env.anonKey, {
      global: { headers: { Authorization: `Bearer ${input.accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Deliberately NO user/student/school identifiers in the row.
    const { error } = await supabase.from("ai_training_examples").insert({
      question_text: input.questionPrompt,
      rubric_text: input.rubric.trim() ? input.rubric : null,
      student_answer_text: input.studentAnswer,
      ai_suggested_score: input.aiSuggestedScore,
      ai_feedback: input.aiFeedback || null,
      teacher_final_score: input.teacherFinalScore,
      teacher_feedback: input.teacherFeedback.trim() ? input.teacherFeedback : null,
      model_name: process.env.AI_MODEL?.trim() || null,
    });
    return { ok: !error };
  },
);
