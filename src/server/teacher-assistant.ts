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
  buildTeacherAssistantSystemPrompt,
  validateTeacherAssistantInput,
  type TeacherWorkspaceSummary,
} from "@/lib/teacher-assistant";

const AI_TIMEOUT_MS = 60_000;
const TEACHER_ROLES = new Set(["school_teacher", "tutor"]);

type AssistantContext = {
  userId: string;
  supabase: SupabaseClient<Database>;
};

type AssistantErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "DB_ERROR"
  | "AI_NOT_CONFIGURED"
  | "AI_AUTH"
  | "AI_RATE_LIMIT"
  | "AI_UPSTREAM"
  | "AI_TIMEOUT"
  | "AI_RATE_LIMIT";

type AssistantResult = { ok: true; reply: string } | { ok: false; code: AssistantErrorCode };

type OverviewResult =
  | { ok: true; configured: boolean; summary: TeacherWorkspaceSummary }
  | { ok: false; code: "UNAUTHORIZED" | "DB_ERROR" };

async function authorizeTeacher({ userId, supabase }: AssistantContext): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  const role = data?.role === "teacher" ? "school_teacher" : data?.role;
  return typeof role === "string" && TEACHER_ROLES.has(role);
}

async function loadWorkspaceSummary({
  userId,
  supabase,
}: AssistantContext): Promise<TeacherWorkspaceSummary | null> {
  // Supabase returns only released score pairs to this server function so it can
  // compute a thresholded average. Individual values stay server-side; only the
  // aggregate summary reaches the browser/model. RLS scopes rows to teacher work.
  const [assessments, drafts, published, awaiting, approved, released, releasedScores] =
    await Promise.all([
      supabase
        .from("assessments")
        .select("id", { count: "exact", head: true })
        .eq("teacher_id", userId),
      supabase
        .from("assessments")
        .select("id", { count: "exact", head: true })
        .eq("teacher_id", userId)
        .eq("status", "draft"),
      supabase
        .from("assessments")
        .select("id", { count: "exact", head: true })
        .eq("teacher_id", userId)
        .eq("status", "published"),
      supabase
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("status", "awaiting_review"),
      supabase
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("status", "approved"),
      supabase
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("status", "released"),
      supabase
        .from("submissions")
        .select("final_score, total_possible")
        .eq("status", "released")
        .not("final_score", "is", null)
        .not("total_possible", "is", null)
        .order("submitted_at", { ascending: false })
        .limit(1_000),
    ]);
  if (
    [assessments, drafts, published, awaiting, approved, released, releasedScores].some(
      (r) => r.error,
    )
  ) {
    return null;
  }
  let scoreTotal = 0;
  let marksTotal = 0;
  let releasedSampleSize = 0;
  for (const row of releasedScores.data ?? []) {
    const score = Number(row.final_score);
    const marks = Number(row.total_possible);
    if (!Number.isFinite(score) || !Number.isFinite(marks) || marks <= 0) continue;
    scoreTotal += score;
    marksTotal += marks;
    releasedSampleSize += 1;
  }
  const averageReleasedPercent =
    releasedSampleSize >= 5 && marksTotal > 0
      ? Math.min(100, Math.max(0, Math.round((scoreTotal / marksTotal) * 100)))
      : null;
  return {
    assessments: assessments.count ?? 0,
    drafts: drafts.count ?? 0,
    published: published.count ?? 0,
    pendingReviews: (awaiting.count ?? 0) + (approved.count ?? 0),
    releasedResults: released.count ?? 0,
    averageReleasedPercent,
    releasedSampleSize,
  };
}

export const getTeacherAssistantOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }): Promise<OverviewResult> => {
    const auth = context as unknown as AssistantContext;
    if (!(await authorizeTeacher(auth))) return { ok: false, code: "UNAUTHORIZED" };
    const summary = await loadWorkspaceSummary(auth);
    if (!summary) return { ok: false, code: "DB_ERROR" };
    return { ok: true, configured: resolveAiConfig() !== null, summary };
  });

export const askTeacherAssistant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }): Promise<AssistantResult> => {
    const input = validateTeacherAssistantInput(data);
    if (!input) return { ok: false, code: "INVALID_INPUT" };

    const auth = context as unknown as AssistantContext;
    if (!(await authorizeTeacher(auth))) return { ok: false, code: "UNAUTHORIZED" };
    const config = resolveAiConfig();
    if (!config) return { ok: false, code: "AI_NOT_CONFIGURED" };
    if (!(await consumeAiRateQuota(auth.supabase))) return { ok: false, code: "AI_RATE_LIMIT" };
    const summary = await loadWorkspaceSummary(auth);
    if (!summary) return { ok: false, code: "DB_ERROR" };

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
          max_tokens: 1_400,
          messages: [
            { role: "system", content: buildTeacherAssistantSystemPrompt(input.language, summary) },
            ...input.messages,
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
      const reply = payload.choices?.[0]?.message?.content?.trim() ?? "";
      if (!reply || reply.length > 10_000) return { ok: false, code: "AI_UPSTREAM" };

      // Usage rows store token counts/model only, never prompts or replies.
      await logAiUsage(auth.supabase, auth.userId, {
        kind: "assistant",
        provider: openAiProvider(config.baseUrl),
        model: config.model,
        usage: extractOpenAiUsage(payload),
      });
      return { ok: true, reply };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return { ok: false, code: timedOut ? "AI_TIMEOUT" : "AI_UPSTREAM" };
    } finally {
      clearTimeout(timeout);
    }
  });
