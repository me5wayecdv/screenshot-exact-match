import { describe, expect, it } from "vitest";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";
import {
  consumeLessonJoinAttempt,
  LESSON_JOIN_LIMIT_WINDOW_MS,
  LESSON_JOIN_MAX_ATTEMPTS,
} from "@/server/d1-lesson-join-limit";

function memoryDb() {
  const rows = new Map<
    string,
    { studentId: string; windowStartedAt: number; attempts: number; updatedAt: number }
  >();
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async first<T>() {
          if (!sql.includes("ON CONFLICT(student_id)") || !sql.includes("RETURNING attempts")) {
            throw new Error("Unexpected SQL in lesson join limiter test");
          }
          const [studentId, nowMs, updatedAt, resetAt, _resetAgain, _resetThird, maxAttempts] =
            params as [string, number, number, number, number, number, number];
          const current = rows.get(studentId);
          if (!current || current.windowStartedAt <= resetAt) {
            const fresh = { studentId, windowStartedAt: nowMs, attempts: 1, updatedAt };
            rows.set(studentId, fresh);
            return { attempts: fresh.attempts } as T;
          }
          if (current.attempts >= maxAttempts) return null;
          current.attempts += 1;
          current.updatedAt = updatedAt;
          return { attempts: current.attempts } as T;
        },
      };
      return statement as unknown as D1Statement;
    },
  } as unknown as D1Database;
  return { db, inspect: (studentId: string) => rows.get(studentId) };
}

describe("lesson join attempt rate limit", () => {
  it("allows ten attempts and blocks the next one within the 15-minute window", async () => {
    const { db, inspect } = memoryDb();
    const now = 1_800_000_000_000;
    for (let i = 0; i < LESSON_JOIN_MAX_ATTEMPTS; i++) {
      expect(await consumeLessonJoinAttempt(db, "student-1", now + i)).toBe(true);
    }
    expect(await consumeLessonJoinAttempt(db, "student-1", now + 20)).toBe(false);
    expect(inspect("student-1")?.attempts).toBe(LESSON_JOIN_MAX_ATTEMPTS);
  });

  it("resets after the window and keeps separate student accounts independent", async () => {
    const { db, inspect } = memoryDb();
    const now = 1_800_000_000_000;
    for (let i = 0; i < LESSON_JOIN_MAX_ATTEMPTS; i++) {
      await consumeLessonJoinAttempt(db, "student-1", now + i);
    }
    expect(
      await consumeLessonJoinAttempt(db, "student-1", now + LESSON_JOIN_LIMIT_WINDOW_MS + 1),
    ).toBe(true);
    expect(inspect()?.attempts).toBe(1);
    expect(await consumeLessonJoinAttempt(db, "student-2", now + 25)).toBe(true);
  });
});
