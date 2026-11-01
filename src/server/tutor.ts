/**
 * Server functions for the Phase 5 smart tutor (student-facing).
 *
 * These run ONLY on the server (TanStack Start server functions). The
 * client imports only the function stubs; the AI key never reaches the
 * browser bundle.
 *
 * PRIVACY MODEL — read this before touching this file:
 * - The caller must be a STUDENT (role "student" in user_roles).
 * - A question is discussable only when the student has a RELEASED
 *   submission for that question's assessment. Unreleased/ungraded work
 *   is never in context, so the tutor cannot leak it.
 * - `question_keys` is NEVER queried here (students cannot read that
 *   table under RLS anyway). The model judges attempts from the question
 *   prompt + options + the student's own answer — exactly what a human
 *   tutor sees. See src/lib/tutor-prompts.ts for the behavioral rules
 *   (hints first, never a ready-made answer, never a guessed key).
 * - Nothing is persisted: chat messages and practice attempts live in
 *   the student's browser session only. A future phase may add a
 *   practice-attempts table; until then the page says so plainly.
 *   Exception (pilot cost measurement only): one ai_usage_events row
 *   per tutor call — token counts + model, never chat content.
 *
 * Provider configuration (server env only, never VITE_): AI_BASE_URL,
 * AI_MODEL, AI_API_KEY — same semantics as src/server/ai-config.ts.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { resolveAiConfig } from "./ai-config";
import {
  consumeAiRateQuota,
  extractOpenAiUsage,
  logAiUsage,
  openAiProvider,
  type AiUsageSink,
} from "./ai-usage";
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

function serverSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env["SUPABASE_URL"]?.trim() || process.env["VITE_SUPABASE_URL"]?.trim();
  const anonKey =
    process.env["SUPABASE_ANON_KEY"]?.trim() ||
    process.env["VITE_SUPABASE_ANON_KEY"]?.trim() ||
    process.env["VITE_SUPABASE_PUBLISHABLE_KEY"]?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

type StudentClient = SupabaseClient;

/** Validate the session and require the student role. */
async function authorizeStudent(
  accessToken: string,
): Promise<{ ok: true; userId: string; client: StudentClient } | { ok: false; message: string }> {
  const env = serverSupabaseEnv();
  if (!env) return { ok: false, message: "Server Supabase environment is not configured." };
  const client = createClient(env.url, env.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await client.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user) return { ok: false, message: "Invalid or expired session." };
  const { data: roleRow } = await client
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (roleRow?.role !== "student") {
    return { ok: false, message: "Only students can use the tutor." };
  }
  return { ok: true, userId: user.id, client };
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
  client: StudentClient,
  userId: string,
  questionId: string,
): Promise<ReleasedQuestion | null> {
  const { data: question } = await client
    .from("questions")
    .select("id, assessment_id, prompt, type, options, objective, marks")
    .eq("id", questionId)
    .maybeSingle();
  if (!question) return null;
  // §6: existence check only — a student may hold several released
  // attempts, so maybeSingle would error on the second one. limit(1).
  const { data: submission } = await client
    .from("submissions")
    .select("id")
    .eq("assessment_id", question.assessment_id)
    .eq("student_id", userId)
    .eq("status", "released")
    .limit(1);
  if (!submission || submission.length === 0) return null;
  return {
    id: question.id,
    assessment_id: question.assessment_id,
    prompt: question.prompt ?? "",
    type: question.type,
    options: Array.isArray(question.options) ? (question.options as string[]) : [],
    objective: question.objective ?? "",
    marks: Number(question.marks) || 0,
  };
}

async function hasReleasedSubmission(
  client: StudentClient,
  userId: string,
  assessmentId: string,
): Promise<boolean> {
  // §6: see loadReleasedQuestion — limit(1), never maybeSingle, because
  // a student may hold several released attempts.
  const { data } = await client
    .from("submissions")
    .select("id")
    .eq("assessment_id", assessmentId)
    .eq("student_id", userId)
    .eq("status", "released")
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function callChat(
  messages: { role: string; content: string }[],
  temperature: number,
  usage?: AiUsageSink,
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
    const reply = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (!reply) {
      return {
        ok: false,
        code: "TUTOR_UPSTREAM",
        message: "AI provider returned an empty response.",
      };
    }
    if (usage) {
      await logAiUsage(usage.client, usage.teacherId, {
        kind: "tutor",
        provider: openAiProvider(config.baseUrl),
        model: config.model,
        usage: extractOpenAiUsage(payload),
      });
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
      .map((item) => ({ objective: item.objective, tip: item.tip }));
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

export const getTutorStatus = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async () => {
    return { configured: resolveAiConfig() !== null };
  });

export const askTutor = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async ({ data }): Promise<TutorResult> => {
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const accessToken = asString(d["accessToken"]);
    const language = isLang(d["language"]) ? d["language"] : "ar";
    const questionId = asString(d["questionId"]) ?? undefined;
    const topic = asString(d["topic"])?.trim() || undefined;
    const studentAnswer = asString(d["studentAnswer"]) ?? "";
    const teacherFeedback = asString(d["teacherFeedback"]) ?? "";
    const mode = d["mode"] === "hint" ? "hint" : "explain";
    const customText = asString(d["customText"])?.trim() || undefined;
    const history = validateHistory(d["messages"]);
    if (!accessToken?.trim() || history === null) {
      return { ok: false, code: "INVALID_INPUT", message: "Invalid request." };
    }
    if ((!questionId && !topic) || (questionId && topic)) {
      return { ok: false, code: "INVALID_INPUT", message: "Provide either a question or a topic." };
    }
    if (customText && customText.length > 2000) {
      return { ok: false, code: "INVALID_INPUT", message: "Message is too long." };
    }
    if (topic && topic.length > 500) {
      return { ok: false, code: "INVALID_INPUT", message: "Topic is too long." };
    }

    const auth = await authorizeStudent(accessToken);
    if (!auth.ok) return { ok: false, code: "UNAUTHORIZED", message: auth.message };
    if (!(await consumeAiRateQuota(auth.client))) {
      return {
        ok: false,
        code: "TUTOR_RATE_LIMIT",
        message: "AI usage limit reached. Try again later.",
      };
    }

    let finalUser: string;
    if (questionId) {
      const question = await loadReleasedQuestion(auth.client, auth.userId, questionId);
      if (!question) {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "This question is not part of a released result for the caller.",
        };
      }
      // The student's latest graded score for this question, for context.
      const { data: answer } = await auth.client
        .from("answers")
        .select("final_score, auto_score, max_marks")
        .eq("question_id", questionId)
        .maybeSingle();
      const ctx: TutorQuestionContext = {
        questionPrompt: question.prompt,
        options: question.options,
        studentAnswer,
        teacherFeedback,
        maxMarks: question.marks,
        score: answer ? (answer.final_score ?? answer.auto_score) : null,
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

    return callChat(
      [
        { role: "system", content: tutorSystemPrompt(language) },
        ...history,
        { role: "user", content: finalUser },
      ],
      0.3,
      { client: auth.client, teacherId: auth.userId },
    );
  });

export const tutorPracticeFeedback = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async ({ data }): Promise<TutorResult> => {
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const accessToken = asString(d["accessToken"]);
    const language = isLang(d["language"]) ? d["language"] : "ar";
    const questionId = asString(d["questionId"]);
    const newAnswer = asString(d["newAnswer"])?.trim() ?? "";
    if (!accessToken?.trim() || !questionId || !newAnswer || newAnswer.length > 5000) {
      return { ok: false, code: "INVALID_INPUT", message: "Invalid request." };
    }
    const auth = await authorizeStudent(accessToken);
    if (!auth.ok) return { ok: false, code: "UNAUTHORIZED", message: auth.message };
    if (!(await consumeAiRateQuota(auth.client))) {
      return {
        ok: false,
        code: "TUTOR_RATE_LIMIT",
        message: "AI usage limit reached. Try again later.",
      };
    }
    const question = await loadReleasedQuestion(auth.client, auth.userId, questionId);
    if (!question) {
      return {
        ok: false,
        code: "UNAUTHORIZED",
        message: "This question is not part of a released result for the caller.",
      };
    }
    return callChat(
      [
        { role: "system", content: tutorSystemPrompt(language) },
        {
          role: "user",
          content: tutorFeedbackPrompt(question.prompt, question.options, newAnswer, language),
        },
      ],
      0.3,
      { client: auth.client, teacherId: auth.userId },
    );
  });

export const tutorStudyTips = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async ({ data }): Promise<TutorTipsResult> => {
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const accessToken = asString(d["accessToken"]);
    const language = isLang(d["language"]) ? d["language"] : "ar";
    const assessmentId = asString(d["assessmentId"]);
    const objectivesRaw = d["objectives"];
    if (
      !accessToken?.trim() ||
      !assessmentId ||
      !Array.isArray(objectivesRaw) ||
      objectivesRaw.length === 0 ||
      objectivesRaw.length > 20 ||
      objectivesRaw.some((o) => typeof o !== "string" || o.length === 0 || o.length > 200)
    ) {
      return { ok: false, code: "INVALID_INPUT", message: "Invalid request." };
    }
    const objectives = objectivesRaw as string[];
    const auth = await authorizeStudent(accessToken);
    if (!auth.ok) return { ok: false, code: "UNAUTHORIZED", message: auth.message };
    if (!(await consumeAiRateQuota(auth.client))) {
      return {
        ok: false,
        code: "TUTOR_RATE_LIMIT",
        message: "AI usage limit reached. Try again later.",
      };
    }
    if (!(await hasReleasedSubmission(auth.client, auth.userId, assessmentId))) {
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
      { client: auth.client, teacherId: auth.userId },
    );
    if (!result.ok) return result;
    const tips = extractTips(result.reply);
    if (!tips) {
      return { ok: false, code: "TUTOR_PARSE_FAILED", message: "Could not parse study tips." };
    }
    return { ok: true, tips, model: result.model };
  });
