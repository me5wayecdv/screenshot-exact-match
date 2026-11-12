/**
 * Regression test for SEC-H1 / BIZ-F3: `removeStudent` must revoke access.
 *
 * Before the fix, `removeStudent` deleted only the `teacher_students` row,
 * leaving the student's `group_members` and `assessment_assignments` rows —
 * exactly the two things the take gate checks — so a "removed" student
 * could keep taking the teacher's exams.
 *
 * Uses a dispatch fake for D1Database with mutable in-memory tables, in the
 * style of src/test/d1-students-reviews.test.ts. `removeStudent` and
 * `canTakeAssessment` run against the same fake, so the test proves the
 * end-to-end effect: after removal, the gate fails for the teacher's exams.
 */
import { describe, expect, it } from "vitest";
import { removeStudent, type Caller } from "@/server/d1-students";
import { canTakeAssessment } from "@/server/d1-take-gate";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

const TEACHER: Caller = { id: "teacher-1", role: "school_teacher" };
const OTHER_TEACHER: Caller = { id: "teacher-2", role: "school_teacher" };
const STUDENT_ID = "student-1";
const NOW = "2026-11-03T20:00:00.000Z";

type State = {
  // teacher_students rows: `${teacherId}:${studentId}`
  teacherStudents: Set<string>;
  // teacher_groups rows: groupId -> teacherId
  groups: Map<string, string>;
  // group_members rows (approved): `${groupId}:${studentId}`
  members: Set<string>;
  // assessments rows: id -> { status, teacherId }
  assessments: Map<string, { status: string; teacherId: string }>;
  // assessment_assignments rows: `${assessmentId}:${studentId}`
  assignments: Set<string>;
  // group_exams links: assessmentId -> groupIds
  groupLinks: Map<string, string[]>;
  // submissions rows (kept as record): `${assessmentId}:${studentId}`
  submissions: Set<string>;
  // handwritten_grades rows (kept as record): grade ids
  handwrittenGrades: Set<string>;
};

function baseState(): State {
  return {
    teacherStudents: new Set(["teacher-1:student-1", "teacher-2:student-1"]),
    groups: new Map([
      ["group-1", "teacher-1"],
      ["group-2", "teacher-2"],
    ]),
    members: new Set(["group-1:student-1", "group-2:student-1"]),
    assessments: new Map([
      ["ex1", { status: "published", teacherId: "teacher-1" }],
      ["ex2", { status: "published", teacherId: "teacher-2" }],
    ]),
    assignments: new Set(["ex1:student-1", "ex2:student-1"]),
    groupLinks: new Map([
      ["ex1", ["group-1"]],
      ["ex2", ["group-2"]],
    ]),
    submissions: new Set(["ex1:student-1"]),
    handwrittenGrades: new Set(["hw-grade-1"]),
  };
}

function fakeDb(state: State): D1Database {
  const handler = (sql: string, params: unknown[]) => {
    // --- removeStudent deletes ---
    if (sql.includes("DELETE FROM teacher_students")) {
      state.teacherStudents.delete(`${params[0]}:${params[1]}`);
      return { changes: 1 };
    }
    if (sql.includes("DELETE FROM group_members")) {
      // removeStudent binds (studentId, teacherId): only the calling
      // teacher's groups.
      const [studentId, teacherId] = params as [string, string];
      for (const key of [...state.members]) {
        const [groupId, memberId] = key.split(":") as [string, string];
        if (memberId === studentId && state.groups.get(groupId) === teacherId) {
          state.members.delete(key);
        }
      }
      return { changes: 1 };
    }
    if (sql.includes("DELETE FROM assessment_assignments")) {
      // removeStudent binds (studentId, teacherId): only the calling
      // teacher's assessments.
      const [studentId, teacherId] = params as [string, string];
      for (const key of [...state.assignments]) {
        const [assessmentId, assigneeId] = key.split(":") as [string, string];
        if (
          assigneeId === studentId &&
          state.assessments.get(assessmentId)?.teacherId === teacherId
        ) {
          state.assignments.delete(key);
        }
      }
      return { changes: 1 };
    }
    // --- take-gate reads ---
    if (sql.includes("FROM assessments WHERE id")) {
      const a = state.assessments.get(params[0] as string);
      return {
        first: a ? { status: a.status, starts_at: null, due_at: null } : null,
      };
    }
    if (sql.includes("FROM assessment_assignments")) {
      return {
        first: state.assignments.has(`${params[0]}:${params[1]}`) ? { one: 1 } : null,
      };
    }
    if (sql.includes("FROM group_exams")) {
      const ids = state.groupLinks.get(params[0] as string) ?? [];
      return { all: ids.map((group_id) => ({ group_id })) };
    }
    if (sql.includes("FROM group_members")) {
      return {
        first: state.members.has(`${params[0]}:${params[1]}`) ? { one: 1 } : null,
      };
    }
    return {};
  };
  const makeStmt = (sql: string): D1Statement => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => (handler(sql, params).first ?? null) as T | null,
      all: async <T>(): Promise<{ results?: T[] }> => ({
        results: (handler(sql, params).all ?? []) as T[],
      }),
      run: async () => ({ meta: { changes: handler(sql, params).changes ?? 1 } }),
    };
    return stmt as unknown as D1Statement;
  };
  return { prepare: makeStmt } as unknown as D1Database;
}

describe("removeStudent revokes exam access (SEC-H1 / BIZ-F3)", () => {
  it("removed student fails the take gate for the teacher's exams", async () => {
    const state = baseState();
    const db = fakeDb(state);
    // Sanity: before removal the student passes the gate.
    expect(await canTakeAssessment(db, STUDENT_ID, "ex1", NOW)).toEqual({ allowed: true });

    await removeStudent(db, TEACHER, STUDENT_ID);

    expect(state.teacherStudents.has("teacher-1:student-1")).toBe(false);
    expect(state.members.has("group-1:student-1")).toBe(false);
    expect(state.assignments.has("ex1:student-1")).toBe(false);
    // No assignment row left, so the gate fails before the group check.
    expect(await canTakeAssessment(db, STUDENT_ID, "ex1", NOW)).toEqual({
      allowed: false,
      reason: "NOT_ASSIGNED",
    });
  });

  it("removal does not touch another teacher's groups or assignments", async () => {
    const state = baseState();
    const db = fakeDb(state);

    await removeStudent(db, TEACHER, STUDENT_ID);

    expect(state.members.has("group-2:student-1")).toBe(true);
    expect(state.assignments.has("ex2:student-1")).toBe(true);
    expect(state.teacherStudents.has("teacher-2:student-1")).toBe(true);
    expect(await canTakeAssessment(db, STUDENT_ID, "ex2", NOW)).toEqual({ allowed: true });
  });

  it("removal keeps submitted work and handwritten grades as record", async () => {
    const state = baseState();
    const db = fakeDb(state);

    await removeStudent(db, TEACHER, STUDENT_ID);

    expect(state.submissions.has("ex1:student-1")).toBe(true);
    expect(state.handwrittenGrades.has("hw-grade-1")).toBe(true);
  });
});
