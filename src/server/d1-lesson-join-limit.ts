import type { D1Database } from "@/server/d1-auth-store";

export const LESSON_JOIN_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const LESSON_JOIN_MAX_ATTEMPTS = 10;

/**
 * Atomically reserves one lesson-join attempt for this student.
 * The limit is per authenticated account (not per IP), so a classroom
 * sharing one school network does not lock out unrelated students.
 */
export async function consumeLessonJoinAttempt(
  db: D1Database,
  studentId: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const expiredBefore = nowMs - LESSON_JOIN_LIMIT_WINDOW_MS;
  const row = await db
    .prepare(
      "INSERT INTO lesson_join_rate_limits (student_id, window_started_at, attempts, updated_at) " +
        "VALUES (?, ?, 1, ?) " +
        "ON CONFLICT(student_id) DO UPDATE SET " +
        "window_started_at = CASE WHEN lesson_join_rate_limits.window_started_at <= ? " +
        "THEN excluded.window_started_at ELSE lesson_join_rate_limits.window_started_at END, " +
        "attempts = CASE WHEN lesson_join_rate_limits.window_started_at <= ? " +
        "THEN 1 ELSE lesson_join_rate_limits.attempts + 1 END, " +
        "updated_at = excluded.updated_at " +
        "WHERE lesson_join_rate_limits.window_started_at <= ? " +
        "OR lesson_join_rate_limits.attempts < ? RETURNING attempts",
    )
    .bind(
      studentId,
      nowMs,
      nowMs,
      expiredBefore,
      expiredBefore,
      expiredBefore,
      LESSON_JOIN_MAX_ATTEMPTS,
    )
    .first<{ attempts: number }>();
  return row !== null;
}
