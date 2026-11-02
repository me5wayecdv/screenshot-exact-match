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
export type { AiGradeSuggestion } from "./ai-client";
import { consumeAiRateQuota, createUsageClient } from "./ai-usage";

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
      code: "INVALID_INPUT" | "UNAUTHORIZED" | "AI_NOT_CONFIGURED" | "AI_ERROR" | "AI_RATE_LIMIT";
      message: string;
    };

const TEACHER_ROLES = new Set(["school_teacher", "tutor", "admin"]);

function serverSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env["SUPABASE_URL"]?.trim() || process.env["VITE_SUPABASE_URL"]?.trim();
  const anonKey =
    process.env["SUPABASE_ANON_KEY"]?.trim() ||
    process.env["VITE_SUPABASE_ANON_KEY"]?.trim() ||
    process.env["VITE_SUPABASE_PUBLISHABLE_KEY"]?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

function validateRequest(data: unknown): AiGradeRequest | { error: string } {
  if (typeof data !== "object" || data === null) return { error: "Request must be an object." };
  const d = data as Record<string, unknown>;
  const asString = (v: unknown) => (typeof v === "string" ? v : null);
  const questionPrompt = asString(d["questionPrompt"]);
  const rubric = asString(d["rubric"]) ?? "";
  const studentAnswer = asString(d["studentAnswer"]);
  const accessToken = asString(d["accessToken"]);
  const maxMarks = typeof d["maxMarks"] === "number" ? d["maxMarks"] : Number(d["maxMarks"]);
  const rawAlternatives: unknown[] = Array.isArray(d["acceptedAlternatives"])
    ? d["acceptedAlternatives"]
    : [];
  const assessmentId = asString(d["assessmentId"]) ?? undefined;
  if (!questionPrompt?.trim()) return { error: "questionPrompt is required." };
  if (studentAnswer === null) return { error: "studentAnswer is required." };
  if (!accessToken?.trim()) return { error: "accessToken is required." };
  if (!Number.isFinite(maxMarks) || maxMarks <= 0 || maxMarks > 1000) {
    return { error: "maxMarks must be a positive number." };
  }
  // Bound the raw array before inspecting its entries, then cap both each
  // alternative and their aggregate. Otherwise a single acceptedAlternatives
  // item could bypass the 20k-per-field limits and the one-unit AI quota.
  if (rawAlternatives.length > 50) {
    return { error: "Input exceeds the maximum allowed size." };
  }
  if (
    rawAlternatives.some((alternative) =>
      typeof alternative !== "string" || alternative.length > 2000,
    )
  ) {
    return { error: "Each accepted alternative must be a string of at most 2000 characters." };
  }
  const acceptedAlternatives = rawAlternatives as string[];
  const alternativesChars = acceptedAlternatives.reduce(
    (total, alternative) => total + alternative.length,
    0,
  );
  if (
    questionPrompt.length > 20000 ||
    rubric.length > 20000 ||
    studentAnswer.length > 20000 ||
    alternativesChars > 20000
  ) {
    return { error: "Input exceeds the maximum allowed size." };
  }
  return {
    questionPrompt,
    rubric,
    acceptedAlternatives,
    studentAnswer,
    maxMarks,
    ...(assessmentId ? { assessmentId } : {}),
    accessToken,
  };
}

/** Verify the caller is a teacher/admin and (when given) owns the assessment. */
async function authorize(
  accessToken: string,
  assessmentId: string | undefined,
): Promise<{ ok: true; userId: string } | { ok: false; message: string }> {
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
  return { ok: true, userId: user.id };
}

/**
 * suggestGrade — server function.
 * Call from the client as: suggestGrade({ data: { ...request } })
 * Returns a discriminated result; it never throws for expected failures, so
 * the UI can distinguish "AI not configured" from other errors.
 */
export const suggestGrade = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async ({ data }): Promise<AiGradeResult> => {
    const request = validateRequest(data);
    if ("error" in request) {
      return { ok: false, code: "INVALID_INPUT", message: request.error };
    }

    const auth = await authorize(request.accessToken, request.assessmentId);
    if (!auth.ok) return { ok: false, code: "UNAUTHORIZED", message: auth.message };

    // A blank answer needs no AI call, but authorization still applies.
    if (!request.studentAnswer.trim()) {
      return {
        ok: true,
        suggestion: { suggestedScore: 0, feedback: "", confidence: "low" },
      };
    }

    const env = serverSupabaseEnv();
    if (!env) return { ok: false, code: "UNAUTHORIZED", message: "Server is not configured." };
    const usageClient = createUsageClient(env.url, env.anonKey, request.accessToken);
    if (!(await consumeAiRateQuota(usageClient))) {
      return {
        ok: false,
        code: "AI_RATE_LIMIT",
        message: "AI usage limit reached. Try again later.",
      };
    }

    // Pilot cost measurement is best-effort and never fails a completed suggestion.
    const result = await suggestGradeWithAi(
      {
        questionPrompt: request.questionPrompt,
        rubric: request.rubric,
        acceptedAlternatives: request.acceptedAlternatives,
        studentAnswer: request.studentAnswer,
        maxMarks: request.maxMarks,
      },
      { client: usageClient, teacherId: auth.userId },
    );
    if (!result.ok) {
      return { ok: false, code: result.error.code, message: result.error.message };
    }
    return { ok: true, suggestion: result.suggestion };
  });

/**
 * getAiGradingStatus — server function.
 * Call from the client as: getAiGradingStatus({ data: {} })
 * Returns only a boolean. It never reveals the key, the model, or the base
 * URL, so the grading UI can show the "AI not configured" state up front.
 */
export const getAiGradingStatus = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async (): Promise<{ configured: boolean }> => {
    return { configured: isAiConfigured() };
  });
