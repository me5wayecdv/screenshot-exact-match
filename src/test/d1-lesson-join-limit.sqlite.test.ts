// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";
import {
  consumeLessonJoinAttempt,
  LESSON_JOIN_LIMIT_WINDOW_MS,
  LESSON_JOIN_MAX_ATTEMPTS,
} from "@/server/d1-lesson-join-limit";

function sqliteD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async first<T>() {
          return (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...(params as never[])) as T[] };
        },
        async run() {
          const result = db.prepare(sql).run(...(params as never[]));
          return { meta: { changes: Number(result.changes) } };
        },
      };
      return statement as unknown as D1Statement;
    },
  } as D1Database;
}

describe("lesson join limiter against SQLite (D1-compatible SQL)", () => {
  const sqlite = new DatabaseSync(":memory:");
  const migration = readFileSync(
    new URL("../../schema/migrations/20261114_lesson_join_rate_limit.sql", import.meta.url),
    "utf8",
  );
  sqlite.exec(migration);
  // D1 migrations may be retried operationally; IF NOT EXISTS must make this safe.
  sqlite.exec(migration);
  const db = sqliteD1(sqlite);

  afterEach(() => {
    sqlite.exec("DELETE FROM lesson_join_rate_limits");
  });

  it("applies the migration and atomically allows only ten concurrent attempts", async () => {
    const now = 1_800_000_000_000;
    const results = await Promise.all(
      Array.from({ length: 25 }, () => consumeLessonJoinAttempt(db, "student-1", now)),
    );
    expect(results.filter(Boolean)).toHaveLength(LESSON_JOIN_MAX_ATTEMPTS);
    expect(results.filter((allowed) => !allowed)).toHaveLength(15);
    const row = sqlite
      .prepare("SELECT attempts FROM lesson_join_rate_limits WHERE student_id = ?")
      .get("student-1") as { attempts: number };
    expect(row.attempts).toBe(LESSON_JOIN_MAX_ATTEMPTS);
    const index = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("lesson_join_rate_limits_updated_idx") as { name: string } | undefined;
    expect(index?.name).toBe("lesson_join_rate_limits_updated_idx");
  });

  it("resets the window after fifteen minutes and isolates student accounts", async () => {
    const now = 1_800_000_000_000;
    for (let i = 0; i < LESSON_JOIN_MAX_ATTEMPTS; i++) {
      expect(await consumeLessonJoinAttempt(db, "student-1", now + i)).toBe(true);
    }
    expect(await consumeLessonJoinAttempt(db, "student-1", now + 10)).toBe(false);
    expect(
      await consumeLessonJoinAttempt(db, "student-1", now + LESSON_JOIN_LIMIT_WINDOW_MS + 1),
    ).toBe(true);
    expect(await consumeLessonJoinAttempt(db, "student-2", now + 20)).toBe(true);
  });
});
