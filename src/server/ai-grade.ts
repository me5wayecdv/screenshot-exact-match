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
 *   The callback's event is captured and logged after a successful
 *   suggestion so the AI-F4 linkage (assessment/question ids,
 *   suggested score) can travel with it.
 * - Persistence (AI-F4): when the caller supplies answer ids, the
 *   suggestion is written best-effort into answers.ai_suggestion
 *   (JSON: suggested_score/feedback/confidence/model) after a
 *   successful AI call, so grading accuracy is measurable from data.
 *   The write never fails the suggestion, and ownership is verified
 *   server-side first (persistAiSuggestion). Without ids — e.g. the
 *   handwritten path, which has no answer row — nothing is persisted.
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
import { consumeAiQuota, logAiUsageEvent, refundAiQuota } from "@/server/d1-quota";
import { isAiConfigured } from "./ai-config";
import { suggestGradeWithAi, type AiGradeSuggestion } from "./ai-client";
import type { AiFailureCode } from "@/lib/ai-failure";
export type { AiGradeSuggestion } from "./ai-client";

export type AiGradeRequest = {
  questionPrompt: string;
  rubric: string;
  acceptedAlternatives: string[];
  studentAnswer: string;
  maxMarks: number;
  /** Optional: when supplied, ownership is verified server-side. */
  assessmentId?: string;
  /**
   * Optional AI-F4 linkage: when supplied, the suggestion is persisted
   * server-side into answers.ai_suggestion (see persistAiSuggestion).
   * answerId alone is enough — submission/question are resolved from
   * the row — but callers that already have them may pass them too;
   * a mismatch with the answer row blocks the write.
   */
  answerId?: string;
  submissionId?: string;
  questionId?: string;
};

export type AiGradeResult =
  | { ok: true; suggestion: AiGradeSuggestion }
  | {
      ok: false;
      // AI_* codes are the shared ai-client taxonomy (AI-F6); AI_ERROR is
      // kept for an unusable model reply (AI-F3 contract).
      code: "INVALID_INPUT" | "UNAUTHORIZED" | AiFailureCode | "AI_ERROR";
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
  const answerId = asString(d["answerId"]) ?? undefined;
  const submissionId = asString(d["submissionId"]) ?? undefined;
  const questionId = asString(d["questionId"]) ?? undefined;
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
    ...(answerId ? { answerId } : {}),
    ...(submissionId ? { submissionId } : {}),
    ...(questionId ? { questionId } : {}),
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

export type AiSuggestionIds = {
  answerId?: string | undefined;
  submissionId?: string | undefined;
  questionId?: string | undefined;
  assessmentId?: string | undefined;
};

type RunMeta = { meta?: { changes?: number } };

function runChanges(result: unknown): number {
  const meta = (result as RunMeta | null | undefined)?.meta;
  return typeof meta?.changes === "number" ? meta.changes : -1;
}

/**
 * persistAiSuggestion — AI-F4 measurement write, best-effort only.
 *
 * Writes the suggestion JSON ({ suggested_score, feedback, confidence,
 * model }) into answers.ai_suggestion so the AI suggestion can later
 * be compared with the teacher's final score (reviewAnswer writes
 * final_score separately; this function never touches grading state).
 *
 * Ownership is verified server-side before any write: the answer's
 * submission must belong to an assessment owned by the calling teacher
 * (admins exempt, as in authorize()). When only submissionId +
 * questionId are given, ownership is checked on the submission instead.
 * A forged id, a mismatched id pair, or a missing row all resolve to
 * false — never to a write, never to a throw.
 *
 * The UPDATE is guarded by submission_id/question_id in the WHERE
 * clause, so it can only ever land on the exact row that was checked.
 * Any persistence error is swallowed: a measurement write must never
 * turn a good suggestion into an error response. Returns true only
 * when exactly one row was updated.
 */
export async function persistAiSuggestion(
  db: D1Database,
  caller: { teacherId: string; isAdmin: boolean },
  ids: AiSuggestionIds,
  suggestion: AiGradeSuggestion,
  model: string,
): Promise<boolean> {
  try {
    if (!ids.answerId && !(ids.submissionId && ids.questionId)) return false;

    let submissionId: string | undefined;
    let questionId: string | undefined;
    if (ids.answerId) {
      const row = await db
        .prepare(
          "SELECT a.submission_id AS submission_id, a.question_id AS question_id, " +
            "s.assessment_id AS assessment_id, ass.teacher_id AS teacher_id " +
            "FROM answers a " +
            "JOIN submissions s ON s.id = a.submission_id " +
            "JOIN assessments ass ON ass.id = s.assessment_id " +
            "WHERE a.id = ?",
        )
        .bind(ids.answerId)
        .first<{
          submission_id: string;
          question_id: string;
          assessment_id: string;
          teacher_id: string;
        }>();
      if (!row) return false;
      if (!caller.isAdmin && row.teacher_id !== caller.teacherId) return false;
      if (ids.submissionId && ids.submissionId !== row.submission_id) return false;
      if (ids.questionId && ids.questionId !== row.question_id) return false;
      if (ids.assessmentId && ids.assessmentId !== row.assessment_id) return false;
      submissionId = row.submission_id;
      questionId = row.question_id;
    } else {
      const row = await db
        .prepare(
          "SELECT s.assessment_id AS assessment_id, ass.teacher_id AS teacher_id " +
            "FROM submissions s " +
            "JOIN assessments ass ON ass.id = s.assessment_id " +
            "WHERE s.id = ?",
        )
        .bind(ids.submissionId)
        .first<{ assessment_id: string; teacher_id: string }>();
      if (!row) return false;
      if (!caller.isAdmin && row.teacher_id !== caller.teacherId) return false;
      if (ids.assessmentId && ids.assessmentId !== row.assessment_id) return false;
      submissionId = ids.submissionId;
      questionId = ids.questionId;
    }

    const payload = JSON.stringify({
      suggested_score: suggestion.suggestedScore,
      feedback: suggestion.feedback,
      confidence: suggestion.confidence,
      model,
    });
    const result = ids.answerId
      ? await db
          .prepare(
            "UPDATE answers SET ai_suggestion = ? " +
              "WHERE id = ? AND submission_id = ? AND question_id = ?",
          )
          .bind(payload, ids.answerId, submissionId, questionId)
          .run()
      : await db
          .prepare(
            "UPDATE answers SET ai_suggestion = ? WHERE submission_id = ? AND question_id = ?",
          )
          .bind(payload, submissionId, questionId)
          .run();
    const changes = runChanges(result);
    // D1 reports changes in meta; a fake without meta still counts a
    // throw-free update as applied.
    return changes === -1 ? true : changes === 1;
  } catch {
    return false;
  }
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
    // The onUsage event is captured here and logged after a successful
    // suggestion, so the AI-F4 linkage (assessment/question ids and the
    // suggested score, only known once the suggestion exists) travels
    // with the usage row.
    let usageEvent:
      | {
          provider: string;
          model: string;
          usage: { inputTokens: number | null; outputTokens: number | null };
        }
      | undefined;
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
        usageEvent = event;
      },
    );
    if (!result.ok) {
      // AI-F5: the AI call failed, so the unit consumed above goes back.
      // Best-effort: a failed refund never changes this failure result.
      await refundAiQuota(db, auth.userId, 1);
      return { ok: false, code: result.error.code, message: result.error.message };
    }
    if (usageEvent) {
      try {
        await logAiUsageEvent(db, auth.userId, {
          kind: "grade",
          provider: usageEvent.provider,
          model: usageEvent.model,
          inputTokens: usageEvent.usage.inputTokens,
          outputTokens: usageEvent.usage.outputTokens,
          assessmentId: request.assessmentId,
          questionId: request.questionId,
          suggestedScore: result.suggestion.suggestedScore,
        });
      } catch {
        // Best-effort measurement: never fails the suggestion.
      }
    }
    // Best-effort measurement write; never fails the suggestion.
    // persistAiSuggestion itself never throws, and it no-ops when no
    // ids were supplied (e.g. the handwritten path, which has no
    // answer row).
    await persistAiSuggestion(
      db,
      { teacherId: auth.userId, isAdmin: normalizeRole(session.role) === "admin" },
      {
        answerId: request.answerId,
        submissionId: request.submissionId,
        questionId: request.questionId,
        assessmentId: request.assessmentId,
      },
      result.suggestion,
      usageEvent?.model ?? "unknown",
    );
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
