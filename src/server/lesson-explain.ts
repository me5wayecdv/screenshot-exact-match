/**
 * Lesson explanation — D1 port (Phase 2b). Behavior preserved from the
 * Supabase original; only the auth, quota, and usage plumbing changed:
 *
 * - Auth: session from requireCloudflareAuth; roles school_teacher /
 *   tutor only (NOT admin — same TEACHER_ROLES set as the original).
 * - The lesson's script decides the explanation language
 *   (detectLessonLanguage); the caller's UI language is only the
 *   fallback for script-neutral text.
 * - The explanation is NOT persisted (mandatory copy in the UI, one
 *   file per explanation — the file itself is persisted first via
 *   the mediated R2 upload in d1-assistant, unchanged).
 * - Quota: D1 consumeAiQuota; usage: D1 logAiUsageEvent (token
 *   counts + model only, never prompts or replies).
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { consumeAiQuota, logAiUsageEvent } from "@/server/d1-quota";
import { resolveAiConfig } from "@/server/ai-config";
import { extractOpenAiUsage, openAiProvider } from "@/server/ai-usage";
import { cleanAiOutputText } from "@/lib/ai-output";
import {
  buildLessonExplainSystemPrompt,
  buildLessonExplainUserPrompt,
  detectLessonLanguage,
  validateLessonExplainInput,
} from "@/lib/lesson-explain";

const AI_TIMEOUT_MS = 120_000;
/** A full structured explanation needs more room than a chat reply. */
const AI_MAX_TOKENS = 3_500;
const MAX_REPLY_CHARS = 20_000;
const TEACHER_ROLES = new Set(["school_teacher", "tutor"]);

type ExplainErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "AI_NOT_CONFIGURED"
  | "AI_AUTH"
  | "AI_RATE_LIMIT"
  | "AI_UPSTREAM"
  | "AI_TIMEOUT";

export type ExplainLessonResult =
  | {
      ok: true;
      explanation: string;
      truncated: boolean;
      originalChars: number;
      cappedChars: number;
    }
  | { ok: false; code: ExplainErrorCode };

function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

function isTeacher(session: AuthSession): boolean {
  return TEACHER_ROLES.has(normalizeRole(session.role));
}

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

export const explainLesson = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }): Promise<ExplainLessonResult> => {
    const input = validateLessonExplainInput(data);
    if (!input) return { ok: false, code: "INVALID_INPUT" };

    // The lesson's script decides the explanation language; the caller's
    // UI language is only the fallback for script-neutral text.
    const language = detectLessonLanguage(input.sourceText, input.language);

    const session = ctxSession(context);
    const db = ctxDb(context);
    if (!isTeacher(session)) return { ok: false, code: "UNAUTHORIZED" };

    const config = resolveAiConfig();
    if (!config) return { ok: false, code: "AI_NOT_CONFIGURED" };
    if (!(await consumeAiQuota(db, session.userId, 1))) {
      return { ok: false, code: "AI_RATE_LIMIT" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.apiKey) headers["authorization"] = `Bearer ${config.apiKey}`;
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: config.model,
          temperature: 0.35,
          max_tokens: AI_MAX_TOKENS,
          messages: [
            { role: "system", content: buildLessonExplainSystemPrompt(language) },
            {
              role: "user",
              content: buildLessonExplainUserPrompt(language, input.sourceText),
            },
          ],
        }),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { ok: false, code: "AI_AUTH" };
        }
        if (response.status === 429) return { ok: false, code: "AI_RATE_LIMIT" };
        return { ok: false, code: "AI_UPSTREAM" };
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: unknown;
      };
      const explanation = cleanAiOutputText(payload.choices?.[0]?.message?.content ?? "");
      if (!explanation || explanation.length > MAX_REPLY_CHARS) {
        return { ok: false, code: "AI_UPSTREAM" };
      }

      // Usage rows store token counts/model only, never prompts or replies.
      const usage = extractOpenAiUsage(payload);
      await logAiUsageEvent(db, session.userId, {
        kind: "assistant",
        provider: openAiProvider(config.baseUrl),
        model: config.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }).catch(() => undefined);
      return {
        ok: true,
        explanation,
        truncated: input.truncated,
        originalChars: input.originalChars,
        cappedChars: input.sourceText.length,
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return { ok: false, code: timedOut ? "AI_TIMEOUT" : "AI_UPSTREAM" };
    } finally {
      clearTimeout(timeout);
    }
  });
