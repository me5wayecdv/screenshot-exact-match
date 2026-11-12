/**
 * D1 teacher assistant (Phase 2 port of /assistant's D1-owned parts).
 *
 * Drafts-only, by design — the assistant CANNOT create/save
 * assessments, approve marks, or release results, and this module
 * enforces that instead of trusting the UI:
 * - `assertAssistantActionAllowed` throws FORBIDDEN for every
 *   create/approve/release/publish action. The chat and lesson-
 *   explain flows are the only allowed actions; anything else is
 *   refused server-side even if a client asks for it.
 * - `getAssistantOverview` returns counts only (own assessments,
 *   drafts, published, pending reviews, released results and their
 *   average percent). It selects NO student names and NO individual
 *   answers — the query touches assessments and submissions only,
 *   and submissions are joined to assessments the caller owns.
 * - Lesson-explain: one file per explanation (the route holds a
 *   single file; this module accepts exactly one upload per call),
 *   persisted to the private generation-sources bucket FIRST via
 *   mediated R2 before any extraction runs, explanation in the
 *   LESSON's language (that rule lives in the explain prompt
 *   builder, unchanged), mandatory copy in the UI, and NOT
 *   persisted — this module writes no explanation row anywhere.
 * - The teacher subject field is stored on the profile only. It is
 *   DELIBERATELY NOT wired into any prompt here: this module never
 *   selects teacher_profiles, and no prompt builder in this file
 *   receives a subject. Keep that separation.
 *
 * NOT migrated here (owned by other workstreams, left on their old
 * path): the chat call (src/server/teacher-assistant.ts), lesson
 * explanation generation (src/server/lesson-explain.ts) and source
 * OCR (src/server/source-ocr.ts) still run against Supabase. The
 * assistant route's direct Supabase call (lesson-source upload) is
 * migrated to uploadLessonSourceD1 below; its chat/explain/OCR
 * calls stay legacy until those files migrate.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import type { R2BucketLike } from "@/server/d1";
import { requireCloudflareAuth } from "@/server/d1-session";
import { log } from "@/lib/logger";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { buildR2Key, r2Put, sourcesBucket } from "@/server/d1-r2";

export type Caller = { id: string; role: string };

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export function isTeacherCaller(caller: Caller): boolean {
  const role = normalizeRole(caller.role);
  return role === "school_teacher" || role === "tutor" || role === "admin";
}

export class AssistantError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "INVALID_INPUT",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AssistantError";
  }
}

function requireTeacher(caller: Caller): void {
  if (!isTeacherCaller(caller)) {
    throw new AssistantError("FORBIDDEN");
  }
}

/** Actions the assistant must refuse, whatever the client asks for. */
export const ASSISTANT_FORBIDDEN_ACTIONS = new Set([
  "create_assessment",
  "save_assessment",
  "create",
  "publish",
  "approve_mark",
  "approve",
  "release_results",
  "release",
  "resolve_review",
  "delete_assessment",
]);

/** Actions the assistant may perform. Everything else is refused. */
export const ASSISTANT_ALLOWED_ACTIONS = new Set(["chat", "explain", "overview"]);

/**
 * Drafts-only guard: throws FORBIDDEN for create/approve/release
 * actions (and for any unknown action). Call this at the top of
 * every assistant server function before doing anything else.
 */
export function assertAssistantActionAllowed(action: string): void {
  if (!ASSISTANT_ALLOWED_ACTIONS.has(action)) {
    // The refused action is diagnostic only — it stays in the server
    // log; the client sees the code, translated by translateError.
    log("warn", "assistant-action-refused", { action });
    throw new AssistantError("FORBIDDEN");
  }
}

export type AssistantSummary = {
  assessments: number;
  drafts: number;
  published: number;
  pendingReviews: number;
  releasedResults: number;
  averageReleasedPercent: number | null;
  releasedSampleSize: number;
};

/**
 * Teacher workspace summary from D1: counts only, own data only.
 * No student names, no individual answers, no teacher_profiles
 * (subject stays profile-only and out of the prompt).
 */
export async function getAssistantOverview(
  db: D1Database,
  caller: Caller,
): Promise<AssistantSummary> {
  requireTeacher(caller);
  assertAssistantActionAllowed("overview");
  const [counts, pending, released] = await Promise.all([
    db
      .prepare(
        "SELECT COUNT(*) AS total, " +
          "SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts, " +
          "SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published " +
          "FROM assessments WHERE teacher_id = ?",
      )
      .bind(caller.id)
      .first<{ total: number; drafts: number; published: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM submissions s " +
          "JOIN assessments a ON a.id = s.assessment_id " +
          "WHERE a.teacher_id = ? AND s.status IN ('awaiting_review', 'approved')",
      )
      .bind(caller.id)
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n, " +
          "AVG(CASE WHEN s.total_possible > 0 THEN s.final_score / s.total_possible * 100 END) AS avg_pct " +
          "FROM submissions s JOIN assessments a ON a.id = s.assessment_id " +
          "WHERE a.teacher_id = ? AND s.status = 'released' AND s.final_score IS NOT NULL",
      )
      .bind(caller.id)
      .first<{ n: number; avg_pct: number | null }>(),
  ]);
  return {
    assessments: counts?.total ?? 0,
    drafts: counts?.drafts ?? 0,
    published: counts?.published ?? 0,
    pendingReviews: pending?.n ?? 0,
    releasedResults: released?.n ?? 0,
    averageReleasedPercent: released?.avg_pct ?? null,
    releasedSampleSize: released?.n ?? 0,
  };
}

const LESSON_SOURCE_EXTS = new Set(["pdf", "docx", "jpg", "jpeg", "png", "webp"]);
const MAX_LESSON_SOURCE_CHARS = 14_000_000;

/**
 * Persist ONE lesson-explain source file to the private sources
 * bucket via mediated R2, before extraction. One file per call —
 * the route passes a single file, and this function accepts exactly
 * one. Nothing about the explanation is persisted.
 */
export async function uploadLessonSource(
  db: D1Database,
  caller: Caller,
  bucket: R2BucketLike,
  input: { dataUrl: string; fileName: string },
): Promise<string> {
  requireTeacher(caller);
  void db;
  const ext = (input.fileName.split(".").pop() ?? "").toLowerCase();
  if (!LESSON_SOURCE_EXTS.has(ext)) {
    throw new AssistantError("INVALID_INPUT");
  }
  if (!input.dataUrl || input.dataUrl.length > MAX_LESSON_SOURCE_CHARS) {
    throw new AssistantError("INVALID_INPUT");
  }
  const b64 = input.dataUrl.split(",", 2)[1];
  if (!b64) throw new AssistantError("INVALID_INPUT");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const safeName = input.fileName.replace(/[\\/]/g, "_");
  const key = buildR2Key(caller.id, crypto.randomUUID(), safeName);
  await r2Put(bucket, caller.id, key, bytes);
  return key;
}

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

function ctxCaller(context: unknown): Caller {
  const s = ctxSession(context);
  return { id: s.userId, role: s.role };
}

export const getAssistantOverviewD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => getAssistantOverview(ctxDb(context), ctxCaller(context)));

export const uploadLessonSourceD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { dataUrl: string; fileName: string })
  .handler(async ({ data, context }) =>
    uploadLessonSource(ctxDb(context), ctxCaller(context), await sourcesBucket(), data),
  );

/** Server wrapper for the drafts-only guard (refuses forbidden actions). */
export const guardAssistantActionD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { action: string })
  .handler(async ({ data }) => {
    assertAssistantActionAllowed(data.action);
    return { allowed: true };
  });
