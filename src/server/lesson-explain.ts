import { createServerFn } from "@tanstack/react-start";
import { resolveAiConfig } from "@/server/ai-config";
import {
  consumeAiRateQuota,
  extractOpenAiUsage,
  logAiUsage,
  openAiProvider,
} from "@/server/ai-usage";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
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

type ExplainContext = {
  userId: string;
  supabase: SupabaseClient<Database>;
};

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

async function authorizeTeacher({ userId, supabase }: ExplainContext): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  const role = data?.role === "teacher" ? "school_teacher" : data?.role;
  return typeof role === "string" && TEACHER_ROLES.has(role);
}

export const explainLesson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }): Promise<ExplainLessonResult> => {
    const input = validateLessonExplainInput(data);
    if (!input) return { ok: false, code: "INVALID_INPUT" };

    // The lesson's script decides the explanation language; the caller's
    // UI language is only the fallback for script-neutral text.
    const language = detectLessonLanguage(input.sourceText, input.language);

    const auth = context as unknown as ExplainContext;
    if (!(await authorizeTeacher(auth))) return { ok: false, code: "UNAUTHORIZED" };

    const config = resolveAiConfig();
    if (!config) return { ok: false, code: "AI_NOT_CONFIGURED" };
    if (!(await consumeAiRateQuota(auth.supabase))) {
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
      const explanation = payload.choices?.[0]?.message?.content?.trim() ?? "";
      if (!explanation || explanation.length > MAX_REPLY_CHARS) {
        return { ok: false, code: "AI_UPSTREAM" };
      }

      // Usage rows store token counts/model only, never prompts or replies.
      await logAiUsage(auth.supabase, auth.userId, {
        kind: "assistant",
        provider: openAiProvider(config.baseUrl),
        model: config.model,
        usage: extractOpenAiUsage(payload),
      });
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
