/**
 * Server functions for AI grading suggestions (slice 1) — D1 port
 * (Phase 2b). Behavior preserved from the Supabase original; only the
 * auth, quota, and usage plumbing changed:
 *
 * - Auth: the session is resolved server-side from the HttpOnly cookie
 *   by requireCloudflareAuth. The client sends NO access token. The
 *   session role (legacy "teacher" rows map to school_teacher) must be
 *   school_teacher, tutor, or admin, and — when assessmentId is
 *   supplied — the assessment must belong to that teacher (admins
 *   exempt). A student session, a missing session, or another
 *   teacher's assessment all return UNAUTHORIZED and never reach the
 *   AI provider.
 * - Quota: D1 consumeAiQuota (30/min, 500/day, fail-closed).
 * - Usage: D1 logAiUsageEvent via ai-client's onUsage callback —
 *   token counts + model only, never prompts, answers, or feedback.
 * - A blank answer still returns score 0 without an AI call, but
 *   authorization still applies first.
 *
 * The AI key, the prompt call, and the auth check never ship to the
 * browser: the client imports only the function stubs.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { consumeAiQuota, logAiUsageEvent } from "@/server/d1-quota";
import { isAiConfigured } from "./ai-config";
import { suggestGradeWithAi, type AiGradeSuggestion } from "./ai-client";
export type { AiGradeSuggestion } from "./ai-client";

export type AiGradeRequest = {
  questionPrompt: string;
  rubric: string;
  acceptedAlternatives: string[];
  studentAnswer: string;
  maxMarks: number;
  /** Optional: when supplied, ownership is verified server-side. */
  assessmentId?: string;
};

export type AiGradeResult =
  | { ok: true; suggestion: AiGradeSuggestion }
  | {
      ok: false;
      code: "INVALID_INPUT" | "UNAUTHORIZED" | "AI_NOT_CONFIGURED" | "AI_ERROR" | "AI_RATE_LIMIT";
      message: string;
    };

const TEACHER_ROLES = new Set(["school_teacher", "tutor", "admin"]);

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

function validateRequest(data: unknown): AiGradeRequest | { error: string } {
  if (typeof data !== "object" || data === null) return { error: "Request must be an object." };
  const d = data as Record<string, unknown>;
  const asString = (v: unknown) => (typeof v === "string" ? v : null);
  const questionPrompt = asString(d["questionPrompt"]);
  const rubric = asString(d["rubric"]) ?? "";
  const studentAnswer = asString(d["studentAnswer"]);
  const maxMarks = typeof d["maxMarks"] === "number" ? d["maxMarks"] : Number(d["maxMarks"]);
  const rawAlternatives: unknown[] = Array.isArray(d["acceptedAlternatives"])
    ? d["acceptedAlternatives"]
    : [];
  const assessmentId = asString(d["assessmentId"]) ?? undefined;
  if (!questionPrompt?.trim()) return { error: "questionPrompt is required." };
  if (studentAnswer === null) return { error: "studentAnswer is required." };
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
    rawAlternatives.some(
      (alternative) => typeof alternative !== "string" || alternative.length > 2000,
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
  };
}

/** Verify the caller is a teacher/admin and (when given) owns the assessment. */
async function authorize(
  db: D1Database,
  session: AuthSession,
  assessmentId: string | undefined,
): Promise<{ ok: true; userId: string } | { ok: false; message: string }> {
  const role = normalizeRole(session.role);
  if (!TEACHER_ROLES.has(role)) {
    return { ok: false, message: "Only teachers can request grading suggestions." };
  }
  if (assessmentId && role !== "admin") {
    const assessment = await db
      .prepare("SELECT teacher_id FROM assessments WHERE id = ?")
      .bind(assessmentId)
      .first<{ teacher_id: string }>();
    if (!assessment || assessment.teacher_id !== session.userId) {
      return { ok: false, message: "This assessment does not belong to the caller." };
    }
  }
  return { ok: true, userId: session.userId };
}

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

/**
 * suggestGrade — server function.
 * Call from the client as: suggestGrade({ data: { ...request } })
 * Returns a discriminated result; it never throws for expected failures, so
 * the UI can distinguish "AI not configured" from other errors.
 */
export const suggestGrade = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }): Promise<AiGradeResult> => {
    const request = validateRequest(data);
    if ("error" in request) {
      return { ok: false, code: "INVALID_INPUT", message: request.error };
    }

    const db = ctxDb(context);
    const session = ctxSession(context);
    const auth = await authorize(db, session, request.assessmentId);
    if (!auth.ok) return { ok: false, code: "UNAUTHORIZED", message: auth.message };

    // A blank answer needs no AI call, but authorization still applies.
    if (!request.studentAnswer.trim()) {
      return {
        ok: true,
        suggestion: { suggestedScore: 0, feedback: "", confidence: "low" },
      };
    }

    if (!(await consumeAiQuota(db, auth.userId, 1))) {
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
      undefined,
      async (event) => {
        await logAiUsageEvent(db, auth.userId, {
          kind: "grade",
          provider: event.provider,
          model: event.model,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
        });
      },
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
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async (): Promise<{ configured: boolean }> => {
    return { configured: isAiConfigured() };
  });
