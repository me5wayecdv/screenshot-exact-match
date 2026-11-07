/**
 * Single-approval-state tests (2026-11-04 fix): approving a student
 * from the Students page (decideEnrollment / approveAllEnrollments)
 * must also approve the student's PENDING memberships in the
 * teacher's groups — exactly the group-card path (link + membership
 * + published linked group exams assigned) — so both views converge.
 *
 * Deliberately unchanged, locked in here:
 * - a REJECTED group membership is NOT revived by a Students-page
 *   approval; it stands until the student re-applies (resetting it
 *   to pending, which a later approval then picks up);
 * - a Students-page rejection does NOT cascade to group memberships;
 * - memberships in another teacher's groups are never touched.
 *
 * Uses a stateful dispatch fake for D1Database, in the style of
 * src/test/d1-groups.test.ts, covering both the d1-students and the
 * d1-groups queries that the shared approval path runs.
 */
import { describe, expect, it } from "vitest";
import { approveAllEnrollments, decideEnrollment, type Caller } from "@/server/d1-students";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type Status = "pending" | "approved" | "rejected";

type State = {
  links: Map<string, Status>; // `${teacher}:${student}`
  members: Map<string, Status>; // `${group}:${student}`
  groups: Map<string, string>; // groupId -> teacherId
  assessments: Map<string, { teacher: string; status: string; mode: string; due: string | null }>;
  groupExams: Set<string>; // `${group}:${assessment}`
  assignments: Set<string>; // `${assessment}:${student}`
  audits: string[];
};

function baseState(): State {
  const s: State = {
    links: new Map(),
    members: new Map(),
    groups: new Map(),
    assessments: new Map(),
    groupExams: new Set(),
    assignments: new Set(),
    audits: [],
  };
  s.groups.set("g-1", "teacher-1");
  s.groups.set("g-2", "teacher-1");
  s.groups.set("g-other", "teacher-2");
  s.assessments.set("a-auto", {
    teacher: "teacher-1",
    status: "published",
    mode: "auto_all",
    due: null,
  });
  s.assessments.set("a-linked", {
    teacher: "teacher-1",
    status: "published",
    mode: "group",
    due: null,
  });
  s.assessments.set("a-draft", { teacher: "teacher-1", status: "draft", mode: "group", due: null });
  s.groupExams.add("g-1:a-linked");
  s.groupExams.add("g-1:a-draft");
  return s;
}

function makeStmt(
  sql: string,
  handler: (sql: string, params: unknown[]) => { first?: unknown; all?: unknown[] },
): D1Statement {
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
    run: async () => {
      handler(sql, params);
      return { meta: { changes: 1 } };
    },
  };
  return stmt as unknown as D1Statement;
}

function fakeDb(s: State): D1Database {
  const handler = (sql: string, params: unknown[]) => {
    // Pending memberships of this student in this teacher's groups.
    if (sql.includes("FROM group_members gm JOIN teacher_groups")) {
      const [teacher, student] = params as string[];
      const rows: { group_id: string }[] = [];
      for (const [key, status] of s.members) {
        const [groupId = "", studentId = ""] = key.split(":");
        if (status === "pending" && studentId === student && s.groups.get(groupId) === teacher) {
          rows.push({ group_id: groupId });
        }
      }
      return { all: rows };
    }
    // Group ownership check.
    if (sql.includes("FROM teacher_groups WHERE id = ? AND teacher_id = ?")) {
      const [groupId = "", teacher = ""] = params as string[];
      return { first: s.groups.get(groupId) === teacher ? { one: 1 } : null };
    }
    // Single group membership lookup.
    if (sql.includes("FROM group_members WHERE group_id = ? AND student_id = ?")) {
      const [groupId, student] = params as string[];
      const status = s.members.get(`${groupId}:${student}`);
      return { first: status ? { status } : null };
    }
    // Membership decision update.
    if (sql.includes("UPDATE group_members SET status")) {
      const [decided, , groupId, student] = params as string[];
      s.members.set(`${groupId}:${student}`, decided as Status);
      return {};
    }
    // Single teacher-link lookup.
    if (
      sql.includes("FROM teacher_students WHERE teacher_id = ? AND student_id = ?") &&
      !sql.includes("status = 'pending'")
    ) {
      const [teacher, student] = params as string[];
      const status = s.links.get(`${teacher}:${student}`);
      return { first: status ? { status } : null };
    }
    // Pending links list (approve-all).
    if (sql.includes("FROM teacher_students WHERE teacher_id = ? AND status = 'pending'")) {
      const [teacher] = params as string[];
      const rows: { student_id: string }[] = [];
      for (const [key, status] of s.links) {
        const [t = "", student = ""] = key.split(":");
        if (t === teacher && status === "pending") rows.push({ student_id: student });
      }
      return { all: rows };
    }
    // Link decision update (decideEnrollment binds decided first;
    // approveTeacherLink / approve-all bind the literal 'approved').
    if (sql.includes("UPDATE teacher_students SET status")) {
      if (sql.includes("SET status = 'approved'")) {
        const [, teacher, student] = params as string[];
        const key = `${teacher}:${student}`;
        if (s.links.get(key) === "pending") s.links.set(key, "approved");
      } else {
        const [decided, , teacher, student] = params as string[];
        s.links.set(`${teacher}:${student}`, decided as Status);
      }
      return {};
    }
    // Link insert (approveTeacherLink's ON CONFLICT DO NOTHING).
    if (sql.includes("INSERT INTO teacher_students")) {
      const [teacher, student, status] = params as string[];
      const key = `${teacher}:${student}`;
      if (!s.links.has(key)) s.links.set(key, status as Status);
      return {};
    }
    // Open published auto_all assessments.
    if (sql.includes("FROM assessments WHERE teacher_id = ?") && sql.includes("auto_all")) {
      const [teacher] = params as string[];
      const rows: { id: string }[] = [];
      for (const [id, a] of s.assessments) {
        if (a.teacher === teacher && a.status === "published" && a.mode === "auto_all") {
          rows.push({ id });
        }
      }
      return { all: rows };
    }
    // Published exams linked to one group.
    if (sql.includes("FROM group_exams ge JOIN assessments")) {
      const [groupId] = params as string[];
      const rows: { assessment_id: string }[] = [];
      for (const key of s.groupExams) {
        const [g = "", assessmentId = ""] = key.split(":");
        if (g === groupId && s.assessments.get(assessmentId)?.status === "published") {
          rows.push({ assessment_id: assessmentId });
        }
      }
      return { all: rows };
    }
    // Assignment inserts (both INSERT OR IGNORE and ON CONFLICT forms).
    if (sql.includes("INTO assessment_assignments")) {
      const [assessmentId, student] = params as string[];
      s.assignments.add(`${assessmentId}:${student}`);
      return {};
    }
    if (sql.includes("INSERT INTO audit_log")) {
      s.audits.push(params[1] as string);
      return {};
    }
    if (sql.includes("DELETE FROM assessment_assignments")) return {};
    return {};
  };
  return {
    prepare: (sql: string) => makeStmt(sql, handler),
    batch: async (stmts: D1Statement[]) => {
      for (const st of stmts) await st.run();
      return stmts.map(() => ({}));
    },
  } as unknown as D1Database;
}

const TEACHER: Caller = { id: "teacher-1", role: "school_teacher" };
const NOW = "2026-11-04T10:00:00.000Z";

describe("Students-page approval is the single approval state", () => {
  it("approves pending group memberships and assigns published linked exams", async () => {
    const s = baseState();
    s.links.set("teacher-1:stu-1", "pending");
    s.members.set("g-1:stu-1", "pending");
    s.members.set("g-2:stu-1", "pending");
    const db = fakeDb(s);
    await decideEnrollment(db, TEACHER, "stu-1", true, NOW);
    expect(s.links.get("teacher-1:stu-1")).toBe("approved");
    expect(s.members.get("g-1:stu-1")).toBe("approved");
    expect(s.members.get("g-2:stu-1")).toBe("approved");
    expect(s.assignments.has("a-auto:stu-1")).toBe(true);
    expect(s.assignments.has("a-linked:stu-1")).toBe(true);
    expect(s.assignments.has("a-draft:stu-1")).toBe(false);
    expect(s.audits).toContain("group_membership_decision");
  });

  it("leaves a rejected group membership rejected and assigns nothing for it", async () => {
    const s = baseState();
    s.links.set("teacher-1:stu-1", "pending");
    s.members.set("g-1:stu-1", "rejected");
    s.members.set("g-2:stu-1", "pending");
    const db = fakeDb(s);
    await decideEnrollment(db, TEACHER, "stu-1", true, NOW);
    expect(s.members.get("g-1:stu-1")).toBe("rejected");
    expect(s.members.get("g-2:stu-1")).toBe("approved");
    // a-linked is linked only to g-1, which stayed rejected: nothing assigned for it.
    expect(s.assignments.has("a-linked:stu-1")).toBe(false);
    expect(s.assignments.has("a-auto:stu-1")).toBe(true);
  });

  it("never touches another teacher's groups", async () => {
    const s = baseState();
    s.links.set("teacher-1:stu-1", "pending");
    s.members.set("g-other:stu-1", "pending");
    const db = fakeDb(s);
    await decideEnrollment(db, TEACHER, "stu-1", true, NOW);
    expect(s.members.get("g-other:stu-1")).toBe("pending");
    expect(s.assignments.has("a-linked:stu-1")).toBe(false);
  });

  it("approve-all approves pending memberships for every approved student", async () => {
    const s = baseState();
    s.links.set("teacher-1:stu-1", "pending");
    s.links.set("teacher-1:stu-2", "pending");
    s.members.set("g-1:stu-1", "pending");
    s.members.set("g-1:stu-2", "pending");
    const db = fakeDb(s);
    expect(await approveAllEnrollments(db, TEACHER, NOW)).toBe(2);
    expect(s.members.get("g-1:stu-1")).toBe("approved");
    expect(s.members.get("g-1:stu-2")).toBe("approved");
    expect(s.assignments.has("a-linked:stu-1")).toBe(true);
    expect(s.assignments.has("a-linked:stu-2")).toBe(true);
  });

  it("rejection leaves group memberships pending (unchanged semantics)", async () => {
    const s = baseState();
    s.links.set("teacher-1:stu-1", "pending");
    s.members.set("g-1:stu-1", "pending");
    const db = fakeDb(s);
    await decideEnrollment(db, TEACHER, "stu-1", false, NOW);
    expect(s.links.get("teacher-1:stu-1")).toBe("rejected");
    expect(s.members.get("g-1:stu-1")).toBe("pending");
  });
});
