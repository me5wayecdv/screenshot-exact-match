/**
 * D1 AI quota (Phase 2 port of Supabase `consume_ai_rate_quota`).
 *
 * Old rule (migration 20261031120000_backend_security_and_scale.sql):
 * 30 weighted units/minute and 500/day per user, one row per user,
 * units 1..20 per call. The Postgres version locked the row
 * (`FOR UPDATE`) inside a transaction; D1 has no row locks, so this
 * port is atomic in a different way: a SINGLE conditional UPDATE
 * whose WHERE clause refuses the increment when either window would
 * exceed its cap. The UPDATE either applies the whole increment or
 * applies nothing — there is no check-then-write race. The statement
 * runs in a db.batch() together with the INSERT OR IGNORE that
 * creates a fresh row, so a first-ever call is atomic too.
 *
 * FAIL-CLOSED (non-negotiable): any error, any unexpected shape, or
 * a 0-row update returns false, and the caller MUST NOT run the AI
 * call. A quota failure never silently allows an AI call.
 *
 * This module also owns ai_usage_events inserts (token counts/model
 * only — never prompts, replies, student names, or answers), which
 * the old `logAiUsage` wrote through Supabase.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";

export const QUOTA_PER_MINUTE = 30;
export const QUOTA_PER_DAY = 500;
export const QUOTA_MAX_UNITS_PER_CALL = 20;

type RunMeta = { meta?: { changes?: number } };

function runChanges(result: unknown): number {
  const meta = (result as RunMeta | null | undefined)?.meta;
  return typeof meta?.changes === "number" ? meta.changes : 0;
}

function minuteOf(nowIso: string): string {
  // "2026-11-03T20:00:00.000Z" -> "2026-11-03T20:00:00.000Z" truncated
  // to the minute; the stored format is fixed UTC ISO, so string
  // comparison is safe (same convention as cloudflare-auth).
  return `${nowIso.slice(0, 16)}:00.000Z`;
}

function dayOf(nowIso: string): string {
  return nowIso.slice(0, 10);
}

/**
 * Atomically consume `units` of AI quota for `userId` at `nowIso`.
 * Returns true only when the increment was applied. Returns false
 * (fail-closed) when the units are invalid, either cap would be
 * exceeded, or anything at all goes wrong.
 */
export async function consumeAiQuota(
  db: D1Database,
  userId: string,
  units: number,
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  try {
    if (!userId || !Number.isInteger(units) || units < 1 || units > QUOTA_MAX_UNITS_PER_CALL) {
      return false;
    }
    const minute = minuteOf(nowIso);
    const day = dayOf(nowIso);
    const insert = db
      .prepare(
        "INSERT OR IGNORE INTO ai_rate_limits " +
          "(user_id, minute_started_at, minute_units, day_started_on, day_units, updated_at) " +
          "VALUES (?, ?, 0, ?, 0, ?)",
      )
      .bind(userId, minute, day, nowIso);
    // One conditional UPDATE: window resets are folded into the
    // CASE expressions, and the WHERE clause blocks the increment
    // when the post-increment total would exceed either cap.
    const update = db
      .prepare(
        "UPDATE ai_rate_limits SET " +
          "minute_started_at = ?, " +
          "minute_units = CASE WHEN minute_started_at <> ? THEN ? ELSE minute_units + ? END, " +
          "day_started_on = ?, " +
          "day_units = CASE WHEN day_started_on <> ? THEN ? ELSE day_units + ? END, " +
          "updated_at = ? " +
          "WHERE user_id = ? " +
          "AND (CASE WHEN minute_started_at <> ? THEN ? ELSE minute_units + ? END) <= ? " +
          "AND (CASE WHEN day_started_on <> ? THEN ? ELSE day_units + ? END) <= ?",
      )
      .bind(
        minute,
        minute,
        units,
        units,
        day,
        day,
        units,
        units,
        nowIso,
        userId,
        minute,
        units,
        units,
        QUOTA_PER_MINUTE,
        day,
        units,
        units,
        QUOTA_PER_DAY,
      );
    let changes: number;
    if (db.batch) {
      const results = (await db.batch([insert, update])) as unknown[];
      changes = runChanges(results[1]);
    } else {
      await insert.run();
      changes = runChanges(await update.run());
    }
    // changes === 1 means this call's increment landed. 0 means the
    // cap blocked it (or the row vanished) — either way, no AI call.
    return changes === 1;
  } catch {
    return false;
  }
}

/**
 * Best-effort refund of `units` of AI quota for `userId` (AI-F5).
 *
 * Reverses one earlier consumeAiQuota increment when the AI call it paid
 * for failed, or the flow aborted before the AI result was used. Each
 * window is decremented only while it is still the window the consume
 * landed in, and floored at 0 (the table also has CHECK (units >= 0)):
 * a refund after the minute rolled over refunds the day window but
 * never debits the new minute window's units.
 *
 * Best-effort by design: it never throws and returns false when the
 * units are invalid, there is no quota row, or anything at all goes
 * wrong. A failed refund must never turn a good response into an error.
 * Callers refund at most once per consume; the 0 floor also makes a
 * repeated refund harmless (it can never drive the counters negative).
 */
export async function refundAiQuota(
  db: D1Database,
  userId: string,
  units: number,
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  try {
    if (!userId || !Number.isInteger(units) || units < 1 || units > QUOTA_MAX_UNITS_PER_CALL) {
      return false;
    }
    const minute = minuteOf(nowIso);
    const day = dayOf(nowIso);
    const result = await db
      .prepare(
        "UPDATE ai_rate_limits SET " +
          "minute_units = CASE WHEN minute_started_at = ? THEN MAX(0, minute_units - ?) ELSE minute_units END, " +
          "day_units = CASE WHEN day_started_on = ? THEN MAX(0, day_units - ?) ELSE day_units END, " +
          "updated_at = ? " +
          "WHERE user_id = ?",
      )
      .bind(minute, units, day, units, nowIso, userId)
      .run();
    return runChanges(result) === 1;
  } catch {
    return false;
  }
}

/** Read the caller's current quota row (own row only). */
export async function getAiQuotaUsage(
  db: D1Database,
  userId: string,
): Promise<{ minuteUnits: number; dayUnits: number } | null> {
  const row = await db
    .prepare("SELECT minute_units, day_units FROM ai_rate_limits WHERE user_id = ?")
    .bind(userId)
    .first<{ minute_units: number; day_units: number }>();
  if (!row) return null;
  return { minuteUnits: row.minute_units, dayUnits: row.day_units };
}

export type AiUsageInput = {
  kind: string;
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** AI-F4: which exam/question the event graded (NULL when unknown). */
  assessmentId?: string | null | undefined;
  questionId?: string | null | undefined;
  /** AI-F4: the AI's suggested score (NULL when unknown / not a grade). */
  suggestedScore?: number | null | undefined;
};

/**
 * Append an ai_usage_events row for the caller's own usage. Stores
 * token counts and model only — never prompts, replies, student
 * names, or individual answers. The optional AI-F4 linkage fields
 * (assessment/question ids, suggested score) let override/agreement
 * rates be computed later; they carry no student content.
 */
export async function logAiUsageEvent(
  db: D1Database,
  teacherId: string,
  input: AiUsageInput,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO ai_usage_events " +
        "(id, teacher_id, kind, provider, model, input_tokens, output_tokens, " +
        "assessment_id, question_id, suggested_score) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      teacherId,
      input.kind,
      input.provider,
      input.model,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.assessmentId ?? null,
      input.questionId ?? null,
      input.suggestedScore ?? null,
    )
    .run();
}

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

/** Server wrapper: consume quota for the session user only. */
export const consumeAiQuotaD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { units: number })
  .handler(async ({ data, context }): Promise<{ allowed: boolean }> => {
    const session = ctxSession(context);
    return { allowed: await consumeAiQuota(ctxDb(context), session.userId, data.units) };
  });

/** Server wrapper: read the session user's own quota row. */
export const getAiQuotaD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => {
    const session = ctxSession(context);
    return getAiQuotaUsage(ctxDb(context), session.userId);
  });
