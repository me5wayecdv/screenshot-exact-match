/**
 * Teacher assistant chat — D1 port (Phase 2b). Behavior preserved from
 * the Supabase original; only the auth, data, quota, and usage
 * plumbing changed:
 *
 * - Auth: session from requireCloudflareAuth; roles school_teacher /
 *   tutor only (NOT admin — same TEACHER_ROLES set as the original).
 * - Workspace summary: D1 counts JOINED to the caller's own
 *   assessments. The original code queried submissions without a
 *   teacher filter and relied on Supabase RLS to scope them; D1 has
 *   no RLS, so the join IS the scoping — replicating the unscoped
 *   queries would leak other teachers' counts. Threshold semantics
 *   preserved: the average shows only with >= 5 usable released
 *   results, rounded and clamped to [0, 100], over the latest 1000.
 * - The summary is counts-only: no student names, no individual
 *   answers, no teacher_profiles — the teacher subject field stays
 *   profile-only and out of prompts (same as before).
 * - The assistant stays drafts-only: this file performs no create /
 *   save / publish / approve / release / resolve / delete action.
 *   Chat and overview are the only actions here.
 * - Quota: D1 consumeAiQuota; usage: D1 logAiUsageEvent (token
 *   counts + model only, never prompts or replies).
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { consumeAiQuota, logAiUsageEvent } from "@/server/d1-quota";
import { resolveAiConfig } from "@/server/ai-config";
import { cleanAiOutputText } from "@/lib/ai-output";
import { extractOpenAiUsage, openAiProvider } from "@/server/ai-usage";
import {
  buildTeacherAssistantSystemPrompt,
  validateTeacherAssistantInput,
  type TeacherWorkspaceSummary,
} from "@/lib/teacher-assistant";

const AI_TIMEOUT_MS = 60_000;
const TEACHER_ROLES = new Set(["school_teacher", "tutor"]);

type AssistantErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "DB_ERROR"
  | "AI_NOT_CONFIGURED"
  | "AI_AUTH"
  | "AI_RATE_LIMIT"
  | "AI_UPSTREAM"
  | "AI_TIMEOUT";

type AssistantResult = { ok: true; reply: string } | { ok: false; code: AssistantErrorCode };

type OverviewResult =
  | { ok: true; configured: boolean; summary: TeacherWorkspaceSummary }
  | { ok: false; code: "UNAUTHORIZED" | "DB_ERROR" };

function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

function isTeacher(session: AuthSession): boolean {
  return TEACHER_ROLES.has(normalizeRole(session.role));
}

/**
 * Teacher workspace summary from D1, counts only, own data only.
 * Every submissions query joins assessments on teacher_id = caller —
 * the D1 equivalent of the RLS scoping the original relied on.
 */
async function loadWorkspaceSummary(
  db: D1Database,
  teacherId: string,
): Promise<TeacherWorkspaceSummary | null> {
  try {
    const [assessments, releasedScores, pending, released] = await Promise.all([
      db
        .prepare(
          "SELECT COUNT(*) AS total, " +
            "SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts, " +
            "SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published " +
            "FROM assessments WHERE teacher_id = ?",
        )
        .bind(teacherId)
        .first<{ total: number; drafts: number; published: number }>(),
      db
        .prepare(
          "SELECT s.final_score AS final_score, s.total_possible AS total_possible " +
            "FROM submissions s JOIN assessments a ON a.id = s.assessment_id " +
            "WHERE a.teacher_id = ? AND s.status = 'released' " +
            "AND s.final_score IS NOT NULL AND s.total_possible IS NOT NULL " +
            "ORDER BY s.submitted_at DESC LIMIT 1000",
        )
        .bind(teacherId)
        .all<{ final_score: number; total_possible: number }>(),
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM submissions s JOIN assessments a ON a.id = s.assessment_id " +
            "WHERE a.teacher_id = ? AND s.status IN ('awaiting_review', 'approved')",
        )
        .bind(teacherId)
        .first<{ n: number }>(),
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM submissions s JOIN assessments a ON a.id = s.assessment_id " +
            "WHERE a.teacher_id = ? AND s.status = 'released'",
        )
        .bind(teacherId)
        .first<{ n: number }>(),
    ]);
    let scoreTotal = 0;
    let marksTotal = 0;
    let releasedSampleSize = 0;
    for (const row of releasedScores.results ?? []) {
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
      assessments: assessments?.total ?? 0,
      drafts: assessments?.drafts ?? 0,
      published: assessments?.published ?? 0,
      pendingReviews: pending?.n ?? 0,
      releasedResults: released?.n ?? 0,
      averageReleasedPercent,
      releasedSampleSize,
    };
  } catch {
    return null;
  }
}

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

export const getTeacherAssistantOverview = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }): Promise<OverviewResult> => {
    const session = ctxSession(context);
    if (!isTeacher(session)) return { ok: false, code: "UNAUTHORIZED" };
    const summary = await loadWorkspaceSummary(ctxDb(context), session.userId);
    if (!summary) return { ok: false, code: "DB_ERROR" };
    return { ok: true, configured: resolveAiConfig() !== null, summary };
  });

export const askTeacherAssistant = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }): Promise<AssistantResult> => {
    const input = validateTeacherAssistantInput(data);
    if (!input) return { ok: false, code: "INVALID_INPUT" };

    const session = ctxSession(context);
    const db = ctxDb(context);
    if (!isTeacher(session)) return { ok: false, code: "UNAUTHORIZED" };
    const config = resolveAiConfig();
    if (!config) return { ok: false, code: "AI_NOT_CONFIGURED" };
    if (!(await consumeAiQuota(db, session.userId, 1))) {
      return { ok: false, code: "AI_RATE_LIMIT" };
    }
    const summary = await loadWorkspaceSummary(db, session.userId);
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
      const reply = cleanAiOutputText(payload.choices?.[0]?.message?.content ?? "");
      if (!reply || reply.length > 10_000) return { ok: false, code: "AI_UPSTREAM" };

      // Usage rows store token counts/model only, never prompts or replies.
      const usage = extractOpenAiUsage(payload);
      await logAiUsageEvent(db, session.userId, {
        kind: "assistant",
        provider: openAiProvider(config.baseUrl),
        model: config.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }).catch(() => undefined);
      return { ok: true, reply };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return { ok: false, code: timedOut ? "AI_TIMEOUT" : "AI_UPSTREAM" };
    } finally {
      clearTimeout(timeout);
    }
  });
