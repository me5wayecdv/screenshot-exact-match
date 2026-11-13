/**
 * Server functions for the Phase 5 smart tutor (student-facing) —
 * D1 port (Phase 2b). Behavior preserved from the Supabase original;
 * only the auth, data, quota, and usage plumbing changed:
 *
 * PRIVACY MODEL — read this before touching this file:
 * - The caller must be a STUDENT (session role "student").
 * - A question is discussable only when the student has a RELEASED
 *   submission for that question's assessment. Unreleased/ungraded work
 *   is never in context, so the tutor cannot leak it.
 * - `question_keys` is NEVER queried here. The model judges attempts
 *   from the question prompt + options + the student's own answer —
 *   exactly what a human tutor sees. See src/lib/tutor-prompts.ts for
 *   the behavioral rules (hints first, never a ready-made answer,
 *   never a guessed key).
 * - Nothing is persisted: chat messages and practice attempts live in
 *   the student's browser session only. A future phase may add a
 *   practice-attempts table; until then the page says so plainly.
 *   Exception (pilot cost measurement only): one ai_usage_events row
 *   per tutor call — token counts + model, never chat content.
 * - Every data query scopes to the caller's OWN rows in SQL
 *   (student_id = caller, status = 'released'). The original relied
 *   on Supabase RLS for that scoping; D1 has no RLS, so the WHERE
 *   clauses below ARE the scoping. The original's unscoped answers
 *   lookup (by question_id only) is tightened here to the caller's
 *   own released submissions — a student can never see another
 *   student's score through this path.
 *
 * Provider configuration (server env only, never VITE_): AI_BASE_URL,
 * AI_MODEL, AI_API_KEY — same semantics as src/server/ai-config.ts.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { consumeAiQuota, logAiUsageEvent, refundAiQuota } from "@/server/d1-quota";

import { resolveAiConfig } from "./ai-config";
import { extractOpenAiUsage, openAiProvider } from "./ai-usage";
import { cleanAiOutputText } from "@/lib/ai-output";
import {
  tutorExplainPrompt,
  tutorFeedbackPrompt,
  tutorHintPrompt,
  tutorSystemPrompt,
  tutorTipsPrompt,
  type TutorLanguage,
  type TutorQuestionContext,
} from "@/lib/tutor-prompts";

export type TutorErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "TUTOR_NOT_CONFIGURED"
  | "TUTOR_UPSTREAM"
  | "TUTOR_TIMEOUT"
  | "TUTOR_PARSE_FAILED"
  | "TUTOR_RATE_LIMIT";

export type TutorResult =
  { ok: true; reply: string; model: string } | { ok: false; code: TutorErrorCode; message: string };

export type TutorTipsResult =
  | { ok: true; tips: { objective: string; tip: string }[]; model: string }
  | { ok: false; code: TutorErrorCode; message: string };

type UsageLogger = (event: {
  provider: string;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
}) => Promise<void>;

/** The session must be a student; anything else is refused before any query. */
function requireStudent(session: AuthSession): string {
  const role = (session.role as string) === "teacher" ? "school_teacher" : session.role;
  if (role !== "student") throw new Error("Only students can use the tutor.");
  return session.userId;
}

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

type ReleasedQuestion = {
  id: string;
  assessment_id: string;
  prompt: string;
  type: string;
  options: string[];
  objective: string;
  marks: number;
};

/**
 * A question is discussable only with a RELEASED submission for its
 * assessment. Returns the question (prompt/options/objective — never a
 * key) or null when the check fails.
 */
async function loadReleasedQuestion(
  db: D1Database,
  userId: string,
  questionId: string,
): Promise<ReleasedQuestion | null> {
  const question = await db
    .prepare(
      "SELECT id, assessment_id, prompt, type, options, objective, marks " +
        "FROM questions WHERE id = ?",
    )
    .bind(questionId)
    .first<{
      id: string;
      assessment_id: string;
      prompt: string | null;
      type: string;
      options: string | null;
      objective: string | null;
      marks: number;
    }>();
  if (!question) return null;
  // §6: existence check only — a student may hold several released
  // attempts, so this is LIMIT 1, never a single-row assertion.
  const submission = await db
    .prepare(
      "SELECT id FROM submissions WHERE assessment_id = ? AND student_id = ? " +
        "AND status = 'released' LIMIT 1",
    )
    .bind(question.assessment_id, userId)
    .first<{ id: string }>();
  if (!submission) return null;
  let options: string[] = [];
  try {
    const parsed = question.options ? JSON.parse(question.options) : [];
    options = Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    options = [];
  }
  return {
    id: question.id,
    assessment_id: question.assessment_id,
    prompt: question.prompt ?? "",
    type: question.type,
    options,
    objective: question.objective ?? "",
    marks: Number(question.marks) || 0,
  };
}

async function hasReleasedSubmission(
  db: D1Database,
  userId: string,
  assessmentId: string,
): Promise<boolean> {
  // §6: see loadReleasedQuestion — LIMIT 1, never a single-row
  // assertion, because a student may hold several released attempts.
  const row = await db
    .prepare(
      "SELECT id FROM submissions WHERE assessment_id = ? AND student_id = ? " +
        "AND status = 'released' LIMIT 1",
    )
    .bind(assessmentId, userId)
    .first<{ id: string }>();
  return row !== null;
}

/** The caller's latest graded score for one question, own released submissions only. */
async function loadLatestOwnScore(
  db: D1Database,
  userId: string,
  questionId: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT a.final_score AS final_score, a.auto_score AS auto_score " +
        "FROM answers a JOIN submissions s ON s.id = a.submission_id " +
        "WHERE a.question_id = ? AND s.student_id = ? AND s.status = 'released' " +
        "ORDER BY s.attempt_number DESC LIMIT 1",
    )
    .bind(questionId, userId)
    .first<{ final_score: number | null; auto_score: number | null }>();
  if (!row) return null;
  return row.final_score ?? row.auto_score ?? null;
}

async function callChat(
  messages: { role: string; content: string }[],
  temperature: number,
  logUsage?: UsageLogger,
): Promise<
  { ok: true; reply: string; model: string } | { ok: false; code: TutorErrorCode; message: string }
> {
  const config = resolveAiConfig();
  if (!config) {
    return {
      ok: false,
      code: "TUTOR_NOT_CONFIGURED",
      message: "AI provider is not configured on the server.",
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) headers["authorization"] = `Bearer ${config.apiKey}`;
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({ model: config.model, temperature, messages }),
    });
    if (!res.ok) {
      return {
        ok: false,
        code: "TUTOR_UPSTREAM",
        message: `AI provider returned HTTP ${res.status}.`,
      };
    }
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: unknown;
    };
    const reply = cleanAiOutputText(payload.choices?.[0]?.message?.content ?? "");
    if (!reply) {
      return {
        ok: false,
        code: "TUTOR_UPSTREAM",
        message: "AI provider returned an empty response.",
      };
    }
    if (logUsage) {
      await logUsage({
        provider: openAiProvider(config.baseUrl),
        model: config.model,
        usage: extractOpenAiUsage(payload),
      }).catch(() => undefined);
    }
    return { ok: true, reply, model: config.model };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      code: timedOut ? "TUTOR_TIMEOUT" : "TUTOR_UPSTREAM",
      message: timedOut ? "AI request timed out." : "AI request failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Tolerate fences/prose around the JSON array (same pattern as OCR). */
function extractTips(raw: string): { objective: string; tip: string }[] | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1]?.trim() ?? trimmed).trim();
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const tips = parsed
      .filter(
        (item): item is { objective: string; tip: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>)["objective"] === "string" &&
          typeof (item as Record<string, unknown>)["tip"] === "string",
      )
      .map((item) => ({ objective: item.objective, tip: cleanAiOutputText(item.tip) }));
    return tips.length > 0 ? tips : null;
  } catch {
    return null;
  }
}

const isLang = (v: unknown): v is TutorLanguage => v === "ar" || v === "en";
const asString = (v: unknown) => (typeof v === "string" ? v : null);

type ChatMessage = { role: "user" | "assistant"; content: string };

function validateHistory(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length > 20) return null;
  const out: ChatMessage[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const rec = item as Record<string, unknown>;
    if (rec["role"] !== "user" && rec["role"] !== "assistant") return null;
    if (typeof rec["content"] !== "string" || rec["content"].length > 2000) return null;
    out.push({ role: rec["role"], content: rec["content"] });
  }
  return out;
}

function usageLogger(db: D1Database, userId: string): UsageLogger {
  return async (event) => {
    await logAiUsageEvent(db, userId, {
      kind: "tutor",
      provider: event.provider,
      model: event.model,
      inputTokens: event.usage.inputTokens,
      outputTokens: event.usage.outputTokens,
    });
  };
}

export const getTutorStatus = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async () => {
    return { configured: resolveAiConfig() !== null };
  });

export const askTutor = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }): Promise<TutorResult> => {
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const language = isLang(d["language"]) ? d["language"] : "ar";
    const questionId = asString(d["questionId"]) ?? undefined;
    const topic = asString(d["topic"])?.trim() || undefined;
    const studentAnswer = asString(d["studentAnswer"]) ?? "";
    const teacherFeedback = asString(d["teacherFeedback"]) ?? "";
    const mode = d["mode"] === "hint" ? "hint" : "explain";
    const customText = asString(d["customText"])?.trim() || undefined;
    const history = validateHistory(d["messages"]);
    if (history === null) {
      return { ok: false, code: "INVALID_INPUT", message: "Invalid request." };
    }
    if ((!questionId && !topic) || (questionId && topic)) {
      return { ok: false, code: "INVALID_INPUT", message: "Provide either a question or a topic." };
    }
    if (questionId && questionId.length > 100) {
      return { ok: false, code: "INVALID_INPUT", message: "Invalid question id." };
    }
    if (studentAnswer.length > 20000 || teacherFeedback.length > 5000) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: "Answer or feedback exceeds the maximum allowed size.",
      };
    }
    if (customText && customText.length > 2000) {
      return { ok: false, code: "INVALID_INPUT", message: "Message is too long." };
    }
    if (topic && topic.length > 500) {
      return { ok: false, code: "INVALID_INPUT", message: "Topic is too long." };
    }

    const session = ctxSession(context);
    const db = ctxDb(context);
    let userId: string;
    try {
      userId = requireStudent(session);
    } catch {
      return { ok: false, code: "UNAUTHORIZED", message: "Only students can use the tutor." };
    }
    if (!(await consumeAiQuota(db, userId, 1))) {
      return {
        ok: false,
        code: "TUTOR_RATE_LIMIT",
        message: "AI usage limit reached. Try again later.",
      };
    }

    let finalUser: string;
    if (questionId) {
      const question = await loadReleasedQuestion(db, userId, questionId);
      if (!question) {
        // AI-F5: the flow aborted before any AI call, so the unit goes back.
        await refundAiQuota(db, userId, 1);
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "This question is not part of a released result for the caller.",
        };
      }
      // The student's latest graded score for this question, for context.
      const score = await loadLatestOwnScore(db, userId, questionId);
      const ctx: TutorQuestionContext = {
        questionPrompt: question.prompt,
        options: question.options,
        studentAnswer,
        teacherFeedback,
        maxMarks: question.marks,
        score,
      };
      finalUser =
        customText ??
        (mode === "hint" ? tutorHintPrompt(ctx, language) : tutorExplainPrompt(ctx, language));
    } else {
      finalUser =
        customText ??
        (language === "en"
          ? `Explain the following topic step by step with hints, not a ready-made answer: ${topic}`
          : `اشرح الموضوع التالي خطوة بخطوة وبتلميحات، لا بإجابة جاهزة: ${topic}`);
    }

    const chatResult = await callChat(
      [
        { role: "system", content: tutorSystemPrompt(language) },
        ...history,
        { role: "user", content: finalUser },
      ],
      0.3,
      usageLogger(db, userId),
    );
    // AI-F5: the AI call failed, so the unit consumed above goes back.
    if (!chatResult.ok) await refundAiQuota(db, userId, 1);
    return chatResult;
  });

export const tutorPracticeFeedback = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }): Promise<TutorResult> => {
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const language = isLang(d["language"]) ? d["language"] : "ar";
    const questionId = asString(d["questionId"]);
    const newAnswer = asString(d["newAnswer"])?.trim() ?? "";
    if (!questionId || questionId.length > 100 || !newAnswer || newAnswer.length > 5000) {
      return { ok: false, code: "INVALID_INPUT", message: "Invalid request." };
    }
    const session = ctxSession(context);
    const db = ctxDb(context);
    let userId: string;
    try {
      userId = requireStudent(session);
    } catch {
      return { ok: false, code: "UNAUTHORIZED", message: "Only students can use the tutor." };
    }
    if (!(await consumeAiQuota(db, userId, 1))) {
      return {
        ok: false,
        code: "TUTOR_RATE_LIMIT",
        message: "AI usage limit reached. Try again later.",
      };
    }
    const question = await loadReleasedQuestion(db, userId, questionId);
    if (!question) {
      // AI-F5: the flow aborted before any AI call, so the unit goes back.
      await refundAiQuota(db, userId, 1);
      return {
        ok: false,
        code: "UNAUTHORIZED",
        message: "This question is not part of a released result for the caller.",
      };
    }
    const chatResult = await callChat(
      [
        { role: "system", content: tutorSystemPrompt(language) },
        {
          role: "user",
          content: tutorFeedbackPrompt(question.prompt, question.options, newAnswer, language),
        },
      ],
      0.3,
      usageLogger(db, userId),
    );
    // AI-F5: the AI call failed, so the unit consumed above goes back.
    if (!chatResult.ok) await refundAiQuota(db, userId, 1);
    return chatResult;
  });

export const tutorStudyTips = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }): Promise<TutorTipsResult> => {
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const language = isLang(d["language"]) ? d["language"] : "ar";
    const assessmentId = asString(d["assessmentId"]);
    const objectivesRaw = d["objectives"];
    if (
      !assessmentId ||
      assessmentId.length > 100 ||
      !Array.isArray(objectivesRaw) ||
      objectivesRaw.length === 0 ||
      objectivesRaw.length > 20 ||
      objectivesRaw.some((o) => typeof o !== "string" || o.length === 0 || o.length > 200)
    ) {
      return { ok: false, code: "INVALID_INPUT", message: "Invalid request." };
    }
    const objectives = objectivesRaw as string[];
    const session = ctxSession(context);
    const db = ctxDb(context);
    let userId: string;
    try {
      userId = requireStudent(session);
    } catch {
      return { ok: false, code: "UNAUTHORIZED", message: "Only students can use the tutor." };
    }
    if (!(await consumeAiQuota(db, userId, 1))) {
      return {
        ok: false,
        code: "TUTOR_RATE_LIMIT",
        message: "AI usage limit reached. Try again later.",
      };
    }
    if (!(await hasReleasedSubmission(db, userId, assessmentId))) {
      // AI-F5: the flow aborted before any AI call, so the unit goes back.
      await refundAiQuota(db, userId, 1);
      return {
        ok: false,
        code: "UNAUTHORIZED",
        message: "This assessment has no released result for the caller.",
      };
    }
    const result = await callChat(
      [
        { role: "system", content: tutorSystemPrompt(language) },
        { role: "user", content: tutorTipsPrompt(objectives, language) },
      ],
      0.3,
      usageLogger(db, userId),
    );
    if (!result.ok) {
      // AI-F5: the AI call failed, so the unit consumed above goes back.
      await refundAiQuota(db, userId, 1);
      return result;
    }
    const tips = extractTips(result.reply);
    if (!tips) {
      // AI-F5: the reply was unusable, so the unit consumed above goes back.
      await refundAiQuota(db, userId, 1);
      return { ok: false, code: "TUTOR_PARSE_FAILED", message: "Could not parse study tips." };
    }
    return { ok: true, tips, model: result.model };
  });
