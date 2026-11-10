/**
 * Tests for D1 lessons (src/server/d1-lessons.ts):
 * - subject list and create are owner-scoped (P3): a tutor only ever
 *   sees or attaches their own subjects (subjects.teacher_id = caller).
 * - the create retry loop only retries a real join_code UNIQUE
 *   collision; any other DB failure surfaces at once.
 */
import { describe, expect, it, vi } from "vitest";
import { createLesson, listTutorLessons, type Caller } from "@/server/d1-lessons";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type Subject = { id: string; name: string; teacher_id: string };

const TUTOR: Caller = { id: "tutor-1", role: "tutor" };
const OTHER: Caller = { id: "tutor-2", role: "tutor" };

function fakeDb(
  subjects: Subject[],
  opts: { runBehavior?: "ok" | "collision-once" | "db-error" } = {},
) {
  const runBehavior = opts.runBehavior ?? "ok";
  let runs = 0;
  const inserted: unknown[][] = [];
  const make = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => {
        if (sql.includes("FROM subjects WHERE id = ?")) {
          // New (owner-scoped) query: id = ? AND teacher_id = ?.
          const row = subjects.find(
            (s) => s.id === params[0] && (params.length < 2 || s.teacher_id === params[1]),
          );
          return (row ? { id: row.id } : null) as T | null;
        }
        return null;
      },
      all: async <T>(): Promise<{ results?: T[] }> => {
        if (sql.includes("FROM lessons WHERE tutor_id = ?")) {
          return { results: [] };
        }
        if (sql.includes("FROM subjects WHERE teacher_id = ?")) {
          // Owner-scoped list: only the caller's subjects (params[0]).
          const rows = subjects
            .filter((s) => s.teacher_id === params[0])
            .map((s) => ({ id: s.id, name: s.name }));
          return { results: rows as unknown as T[] };
        }
        if (sql.includes("FROM lessons l LEFT JOIN lesson_enrollments")) {
          return { results: [] };
        }
        return { results: [] };
      },
      run: async () => {
        runs++;
        if (runBehavior === "db-error") {
          throw new Error("D1 boom");
        }
        if (runBehavior === "collision-once" && runs === 1) {
          throw new Error("UNIQUE constraint failed: lessons.join_code");
        }
        inserted.push(params);
        return { meta: { changes: 1 } };
      },
    };
    return stmt as unknown as D1Statement;
  };
  const db = { prepare: (sql: string) => make(sql) } as unknown as D1Database;
  return { db, inserted, runs: () => runs };
}

const SUBJECTS: Subject[] = [
  { id: "sub-own", name: "Own subject", teacher_id: "tutor-1" },
  { id: "sub-other", name: "Other teacher subject", teacher_id: "tutor-2" },
];

describe("D1 lessons — subject ownership (P3)", () => {
  it("listTutorLessons returns only the caller's own subjects", async () => {
    const { db } = fakeDb(SUBJECTS);
    const out = await listTutorLessons(db, TUTOR, 0);
    expect(out.subjects.map((s) => s.id)).toEqual(["sub-own"]);
  });

  it("createLesson rejects another teacher's subject", async () => {
    const { db } = fakeDb(SUBJECTS);
    await expect(
      createLesson(db, TUTOR, { title: "L", description: "", subjectId: "sub-other" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("createLesson accepts the caller's own subject", async () => {
    const { db, inserted } = fakeDb(SUBJECTS);
    const out = await createLesson(db, TUTOR, {
      title: "L",
      description: "",
      subjectId: "sub-own",
    });
    expect(out.id).toBeTruthy();
    expect(out.joinCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.[2]).toBe("sub-own");
  });

  it("createLesson with a null subject skips the ownership check", async () => {
    const { db, inserted } = fakeDb(SUBJECTS);
    await createLesson(db, TUTOR, { title: "L", description: "", subjectId: null });
    expect(inserted).toHaveLength(1);
  });

  it("createLesson retries a join_code collision and then succeeds", async () => {
    const { db, runs } = fakeDb(SUBJECTS, { runBehavior: "collision-once" });
    const out = await createLesson(db, TUTOR, {
      title: "L",
      description: "",
      subjectId: null,
    });
    expect(out.joinCode).toBeTruthy();
    expect(runs()).toBe(2);
  });

  it("createLesson surfaces a non-collision DB error at once (no retries)", async () => {
    const { db, runs } = fakeDb(SUBJECTS, { runBehavior: "db-error" });
    await expect(
      createLesson(db, TUTOR, { title: "L", description: "", subjectId: null }),
    ).rejects.toThrow("D1 boom");
    expect(runs()).toBe(1);
  });

  it("a second tutor cannot see the first tutor's subjects", async () => {
    const { db } = fakeDb(SUBJECTS);
    const out = await listTutorLessons(db, OTHER, 0);
    expect(out.subjects.map((s) => s.id)).toEqual(["sub-other"]);
  });
});
