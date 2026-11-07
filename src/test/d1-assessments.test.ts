/**
 * Tests for the D1 assessments server functions (src/server/d1-assessments.ts).
 * Uses a dispatch fake for D1Database (same pattern as
 * src/test/d1-take-gate.test.ts): the fake answers each query shape
 * from in-memory rows and records every SQL string + bound params, so
 * the tests prove the ownership checks and the publish rule without a
 * Worker binding or a live D1.
 */
import { describe, expect, it } from "vitest";
import {
  getBuilderData,
  getStudentHome,
  listTeacherAssessments,
  setAssessmentStatus,
  toggleAssignment,
} from "@/server/d1-assessments";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type State = {
  assessments: Record<string, { teacher_id: string; status: string; audience_mode: string }>;
  questions: Record<
    string,
    { prompt: string; type: string; options: string; correct_answer: string; rubric: string }[]
  >;
  approved: Record<string, string[]>; // teacherId -> studentIds
  assignments: Set<string>; // `${assessmentId}:${studentId}`
  seen: string[];
  runs: { sql: string; params: unknown[] }[];
};

function fakeDb(state: State): D1Database {
  const stmt = (kind: string, params: unknown[]): D1Statement => {
    const first = async <T>(): Promise<T | null> => {
      if (kind === "assessment") {
        const row = state.assessments[params[0] as string];
        if (!row || row.teacher_id !== params[1]) return null;
        return row as unknown as T;
      }
      if (kind === "link") {
        const approved = state.approved[params[0] as string] ?? [];
        return approved.includes(params[1] as string) ? ({ one: 1 } as unknown as T) : null;
      }
      if (kind === "count-assignments") {
        const id = params[0] as string;
        let n = 0;
        for (const key of state.assignments) if (key.startsWith(`${id}:`)) n++;
        return { n } as unknown as T;
      }
      if (kind === "count-submissions") return { n: 0 } as unknown as T;
      return null;
    };
    const all = async <T>(): Promise<{ results?: T[] }> => {
      if (kind === "questions") {
        const rows = state.questions[params[0] as string] ?? [];
        return { results: rows as unknown as T[] };
      }
      if (kind === "subjects") return { results: [] };
      if (kind === "roster") {
        const ids = state.approved[params[0] as string] ?? [];
        return {
          results: ids.map((student_id) => ({
            student_id,
            full_name: student_id,
            status: "approved",
            requested_at: null,
          })) as unknown as T[],
        };
      }
      if (kind === "approved-list") {
        const ids = state.approved[params[0] as string] ?? [];
        return { results: ids.map((student_id) => ({ student_id })) as unknown as T[] };
      }
      if (kind === "assigned") {
        const id = params[0] as string;
        const ids = [...state.assignments]
          .filter((k) => k.startsWith(`${id}:`))
          .map((k) => k.split(":")[1]!);
        return { results: ids.map((student_id) => ({ student_id })) as unknown as T[] };
      }
      if (kind === "teacher-list") {
        return {
          results: [
            {
              id: "a1",
              title: "Exam 1",
              status: "draft",
              due_at: null,
              created_at: "2026-11-01T00:00:00.000Z",
              subject_name: null,
            },
            {
              id: "a2",
              title: "Exam 2",
              status: "published",
              due_at: null,
              created_at: "2026-11-02T00:00:00.000Z",
              subject_name: "Math",
            },
          ] as unknown as T[],
        };
      }
      if (kind === "student-assessments") {
        return {
          results: [
            {
              id: "a1",
              title: "Exam 1",
              instructions: "",
              due_at: null,
              starts_at: null,
              status: "published",
            },
          ] as unknown as T[],
        };
      }
      if (kind === "student-lessons") return { results: [] };
      if (kind === "pending") return { results: [] };
      return { results: [] };
    };
    const run = async (): Promise<unknown> => {
      if (kind === "run") {
        // run() statements are recorded by prepare(); nothing to apply
        // here except assignment inserts, handled in prepare's wrapper.
      }
      return undefined;
    };
    return { bind: () => stmt(kind, params), first, all, run } as unknown as D1Statement;
  };
  return {
    prepare(sql: string): D1Statement {
      state.seen.push(sql);
      let kind = "unknown";
      if (sql.startsWith("SELECT * FROM assessments")) kind = "assessment";
      else if (
        sql.includes("FROM teacher_students") &&
        sql.includes("status = 'approved'") &&
        sql.includes("SELECT 1")
      )
        kind = "link";
      else if (sql.startsWith("SELECT COUNT(*) AS n FROM assessment_assignments"))
        kind = "count-assignments";
      else if (sql.startsWith("SELECT COUNT(*) AS n FROM submissions")) kind = "count-submissions";
      else if (sql.includes("FROM questions q LEFT JOIN question_keys")) kind = "questions";
      else if (sql.includes("FROM subjects WHERE teacher_id")) kind = "subjects";
      else if (sql.includes("status = 'pending'")) kind = "pending";
      else if (sql.includes("FROM teacher_students ts LEFT JOIN profiles")) kind = "roster";
      else if (sql.startsWith("SELECT student_id FROM teacher_students")) kind = "approved-list";
      else if (sql.startsWith("SELECT student_id FROM assessment_assignments")) kind = "assigned";
      else if (sql.includes("FROM assessments a LEFT JOIN subjects")) kind = "teacher-list";
      else if (sql.includes("FROM assessment_assignments aa JOIN assessments"))
        kind = "student-assessments";
      else if (sql.includes("FROM lesson_enrollments e")) kind = "student-lessons";
      else if (sql.startsWith("SELECT full_name")) kind = "profile";
      else if (sql.startsWith("SELECT COUNT(*) AS n FROM teacher_students")) kind = "links-count";
      else kind = "run";
      let params: unknown[] = [];
      const base = stmt(kind, params);
      return {
        bind: (...p: unknown[]) => {
          params = p;
          // Apply mutation statements to the in-memory state so later
          // reads (e.g. the publish reach count) see the write.
          if (sql.startsWith("INSERT OR IGNORE INTO assessment_assignments")) {
            state.assignments.add(`${p[0]}:${p[1]}`);
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("DELETE FROM assessment_assignments")) {
            state.assignments.delete(`${p[0]}:${p[1]}`);
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("UPDATE assessments SET status")) {
            const row = state.assessments[p[3] as string];
            if (row) {
              row.status = p[0] as string;
              if (p[2]) row.audience_mode = p[2] as string;
            }
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("UPDATE assessments SET audience_mode")) {
            const row = state.assessments[p[1] as string];
            if (row) row.audience_mode = p[0] as string;
            state.runs.push({ sql, params: p });
          } else if (
            sql.startsWith("INSERT INTO audit_log") ||
            sql.startsWith("INSERT INTO assessments")
          ) {
            state.runs.push({ sql, params: p });
          }
          return stmt(kind, params);
        },
        first: base.first,
        all: base.all,
        run: base.run,
      } as unknown as D1Statement;
    },
  };
}

function baseState(): State {
  return {
    assessments: {
      ex1: { teacher_id: "teacher-1", status: "draft", audience_mode: "explicit" },
    },
    questions: {
      ex1: [
        {
          prompt: "2 + 2?",
          type: "mcq",
          options: '["3","4"]',
          correct_answer: "4",
          rubric: "",
        },
      ],
    },
    approved: { "teacher-1": ["student-a", "student-b"] },
    assignments: new Set(),
    seen: [],
    runs: [],
  };
}

describe("d1-assessments: ownership", () => {
  it("a non-owner teacher gets NOT_FOUND, never another teacher's builder data", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await expect(getBuilderData(db, "teacher-2", "ex1")).rejects.toThrow("NOT_FOUND");
    // No question/key row was ever selected for the non-owner: the
    // ownership check runs first and throws.
    expect(state.seen.some((sql) => sql.includes("question_keys"))).toBe(false);
  });

  it("a non-owner teacher cannot publish another teacher's assessment", async () => {
    const db = fakeDb(baseState());
    await expect(setAssessmentStatus(db, "teacher-2", "ex1", "published")).rejects.toThrow(
      "NOT_FOUND",
    );
  });

  it("toggleAssignment refuses a student who is not approved-linked", async () => {
    const db = fakeDb(baseState());
    await expect(toggleAssignment(db, "teacher-1", "ex1", "student-z", true)).rejects.toThrow(
      "NOT_FOUND",
    );
    expect([...baseState().assignments].length).toBe(0);
  });
});

describe("d1-assessments: publish rule", () => {
  it("publishing with no selection auto-assigns all approved students", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const result = await setAssessmentStatus(db, "teacher-1", "ex1", "published");
    expect(result.mode).toBe("auto_all");
    expect(result.reach).toBe(2);
    expect(state.assignments.has("ex1:student-a")).toBe(true);
    expect(state.assignments.has("ex1:student-b")).toBe(true);
    expect(state.assessments["ex1"]?.audience_mode).toBe("auto_all");
  });

  it("publishing a strict subset never widens it", async () => {
    const state = baseState();
    state.assignments.add("ex1:student-a");
    const db = fakeDb(state);
    const result = await setAssessmentStatus(db, "teacher-1", "ex1", "published");
    expect(result.mode).toBe("explicit");
    expect(result.reach).toBe(1);
    expect(state.assignments.has("ex1:student-b")).toBe(false);
  });

  it("publishing with no approved students is blocked", async () => {
    const state = baseState();
    state.approved = { "teacher-1": [] };
    const db = fakeDb(state);
    await expect(setAssessmentStatus(db, "teacher-1", "ex1", "published")).rejects.toThrow(
      "PUBLISH_NO_STUDENTS",
    );
    expect(state.assessments["ex1"]?.status).toBe("draft");
  });

  it("publishing with no questions is blocked", async () => {
    const state = baseState();
    state.questions = { ex1: [] };
    const db = fakeDb(state);
    await expect(setAssessmentStatus(db, "teacher-1", "ex1", "published")).rejects.toThrow(
      "PUBLISH_NO_QUESTIONS",
    );
  });

  it("publishing an incomplete question is blocked", async () => {
    const state = baseState();
    state.questions = {
      ex1: [{ prompt: "2 + 2?", type: "mcq", options: '["4"]', correct_answer: "4", rubric: "" }],
    };
    const db = fakeDb(state);
    await expect(setAssessmentStatus(db, "teacher-1", "ex1", "published")).rejects.toThrow(
      "PUBLISH_INCOMPLETE",
    );
  });

  it("an invalid transition is rejected", async () => {
    const state = baseState();
    state.assessments["ex1"]!.status = "archived";
    const db = fakeDb(state);
    await expect(setAssessmentStatus(db, "teacher-1", "ex1", "published")).rejects.toThrow(
      "INVALID_TRANSITION",
    );
  });
});

describe("d1-assessments: lists and student home", () => {
  it("lists the teacher's own assessments", async () => {
    const db = fakeDb(baseState());
    const result = await listTeacherAssessments(db, "teacher-1", 0, 20);
    expect(result.rows.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(result.rows[1]?.subjectName).toBe("Math");
  });

  it("student home query enforces assigned + published/closed + group rule in SQL", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const home = await getStudentHome(db, "student-a", 0, 0);
    expect(home.assessments.map((a) => a.id)).toEqual(["a1"]);
    const studentSql = state.seen.find((sql) =>
      sql.includes("FROM assessment_assignments aa JOIN assessments"),
    );
    expect(studentSql).toBeDefined();
    expect(studentSql).toContain("status IN ('published', 'closed')");
    expect(studentSql).toContain("group_exams");
    expect(studentSql).toContain("status = 'approved'");
    // Drafts are never in the student payload.
    expect(home.assessments.every((a) => a.status !== "draft")).toBe(true);
  });
});
