/**
 * Tests for D1 students/enrollment (d1-students.ts), profile
 * (d1-profile.ts) and grade reviews (d1-reviews.ts), using dispatch
 * fakes. These routes had no home in the batch's enumerated server
 * list, so their server functions live in new files (see headers).
 */
import { describe, expect, it } from "vitest";
import {
  approveAllEnrollments,
  decideEnrollment,
  listStudentRoster,
  type Caller,
} from "@/server/d1-students";
import { getMyProfileExtra, updateMyFullName, updateMySubject } from "@/server/d1-profile";
import {
  listQuestionsForReleasedAssessment,
  listReviewRequests,
  resolveReviewRequest,
  submitReviewRequest,
} from "@/server/d1-reviews";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type Link = {
  teacher_id: string;
  student_id: string;
  status: string;
  requested_at: string;
  created_at: string;
};

function makeStmt(
  sql: string,
  handler: (
    sql: string,
    params: unknown[],
  ) => { first?: unknown; all?: unknown[]; changes?: number },
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
    run: async () => ({ meta: { changes: handler(sql, params).changes ?? 1 } }),
  };
  return stmt as unknown as D1Statement;
}

function fakeDb(
  handler: (
    sql: string,
    params: unknown[],
  ) => { first?: unknown; all?: unknown[]; changes?: number },
): D1Database {
  return {
    prepare: (sql: string) => makeStmt(sql, handler),
    batch: async (stmts: D1Statement[]) => {
      for (const s of stmts) await s.run();
      return stmts.map(() => ({}));
    },
  } as unknown as D1Database;
}

const TEACHER: Caller = { id: "teacher-1", role: "school_teacher" };
const STUDENT: Caller = { id: "student-1", role: "student" };

// ------------------------------------------------------------ students
function studentsDb(links: Link[], assignments: Set<string>, audits: string[]) {
  return fakeDb((sql, params) => {
    if (sql.includes("FROM teacher_students ts")) {
      const rows = links
        .filter((l) => l.teacher_id === params[0])
        .map((l) => ({
          student_id: l.student_id,
          full_name: `Name-${l.student_id}`,
          status: l.status,
          requested_at: l.requested_at,
          created_at: l.created_at,
          // SQL CASE: contact data only for approved rows.
          parent_phone: l.status === "approved" ? "01000000000" : null,
          whatsapp_consent: l.status === "approved" ? 1 : 0,
        }));
      return { all: rows };
    }
    if (
      sql.includes("FROM teacher_students WHERE teacher_id") &&
      sql.includes("status = 'pending'")
    ) {
      return {
        all: links
          .filter((l) => l.teacher_id === params[0] && l.status === "pending")
          .map((l) => ({ student_id: l.student_id })),
      };
    }
    if (
      sql.includes("FROM teacher_students WHERE teacher_id") &&
      sql.includes("AND student_id = ?")
    ) {
      const l = links.find((x) => x.teacher_id === params[0] && x.student_id === params[1]);
      return { first: l ? { status: l.status } : null };
    }
    if (sql.includes("UPDATE teacher_students SET status")) {
      // decideEnrollment binds (decided, now, teacher, student);
      // approveAllEnrollments binds (now, teacher, student) with a
      // literal 'approved' in the SQL.
      const isApproveAll = sql.includes("SET status = 'approved'");
      const teacher = isApproveAll ? params[1] : params[2];
      const student = isApproveAll ? params[2] : params[3];
      const l = links.find((x) => x.teacher_id === teacher && x.student_id === student);
      if (l) l.status = isApproveAll ? "approved" : (params[0] as string);
      return { changes: 1 };
    }
    if (sql.includes("SELECT id FROM assessments") && sql.includes("auto_all")) {
      return { all: [{ id: "assess-auto" }] };
    }
    if (sql.includes("INSERT OR IGNORE INTO assessment_assignments")) {
      assignments.add(`${params[0]}:${params[1]}`);
      return { changes: 1 };
    }
    if (sql.includes("INSERT INTO audit_log")) {
      audits.push(params[1] as string);
      return { changes: 1 };
    }
    if (sql.includes("DELETE FROM teacher_students")) return { changes: 1 };
    if (sql.includes("DELETE FROM assessment_assignments")) return { changes: 1 };
    return {};
  });
}

describe("D1 students / enrollment", () => {
  it("roster exposes contact data only for approved students", async () => {
    const db = studentsDb(
      [
        {
          teacher_id: "teacher-1",
          student_id: "s-approved",
          status: "approved",
          requested_at: "2026-11-01T00:00:00.000Z",
          created_at: "2026-11-01T00:00:00.000Z",
        },
        {
          teacher_id: "teacher-1",
          student_id: "s-pending",
          status: "pending",
          requested_at: "2026-11-02T00:00:00.000Z",
          created_at: "2026-11-02T00:00:00.000Z",
        },
        {
          teacher_id: "teacher-2",
          student_id: "s-other",
          status: "approved",
          requested_at: "2026-11-01T00:00:00.000Z",
          created_at: "2026-11-01T00:00:00.000Z",
        },
      ],
      new Set(),
      [],
    );
    const rows = await listStudentRoster(db, TEACHER);
    expect(rows.map((r) => r.student_id).sort()).toEqual(["s-approved", "s-pending"]);
    expect(rows.find((r) => r.student_id === "s-approved")?.parent_phone).toBe("01000000000");
    expect(rows.find((r) => r.student_id === "s-pending")?.parent_phone).toBeNull();
    await expect(listStudentRoster(db, STUDENT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("decide approves pending (and assigns auto_all) but not already-approved rows", async () => {
    const links: Link[] = [
      {
        teacher_id: "teacher-1",
        student_id: "s-pending",
        status: "pending",
        requested_at: "2026-11-02T00:00:00.000Z",
        created_at: "2026-11-02T00:00:00.000Z",
      },
      {
        teacher_id: "teacher-1",
        student_id: "s-approved",
        status: "approved",
        requested_at: "2026-11-01T00:00:00.000Z",
        created_at: "2026-11-01T00:00:00.000Z",
      },
    ];
    const assignments = new Set<string>();
    const db = studentsDb(links, assignments, []);
    await decideEnrollment(db, TEACHER, "s-pending", true);
    expect(links[0]?.status).toBe("approved");
    expect(assignments.has("assess-auto:s-pending")).toBe(true);
    await expect(decideEnrollment(db, TEACHER, "s-approved", true)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(decideEnrollment(db, STUDENT, "s-pending", true)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("approve-all approves only pending rows and audits the count", async () => {
    const links: Link[] = [
      {
        teacher_id: "teacher-1",
        student_id: "s-1",
        status: "pending",
        requested_at: "2026-11-02T00:00:00.000Z",
        created_at: "2026-11-02T00:00:00.000Z",
      },
      {
        teacher_id: "teacher-1",
        student_id: "s-2",
        status: "pending",
        requested_at: "2026-11-02T00:00:00.000Z",
        created_at: "2026-11-02T00:00:00.000Z",
      },
      {
        teacher_id: "teacher-1",
        student_id: "s-3",
        status: "rejected",
        requested_at: "2026-11-01T00:00:00.000Z",
        created_at: "2026-11-01T00:00:00.000Z",
      },
    ];
    const audits: string[] = [];
    const db = studentsDb(links, new Set(), audits);
    expect(await approveAllEnrollments(db, TEACHER)).toBe(2);
    expect(
      links
        .filter((l) => l.status === "approved")
        .map((l) => l.student_id)
        .sort(),
    ).toEqual(["s-1", "s-2"]);
    expect(audits).toContain("enrollment_approve_all");
  });
});

// ------------------------------------------------------------- profile
describe("D1 profile (own row only)", () => {
  it("reads own created_at/subject and updates only the caller's row", async () => {
    const profiles = new Map<string, { full_name: string; created_at: string }>([
      ["teacher-1", { full_name: "Old", created_at: "2026-10-01T00:00:00.000Z" }],
    ]);
    const subjects = new Map<string, string>([["teacher-1", "Math"]]);
    const db = fakeDb((sql, params) => {
      if (sql.includes("FROM profiles WHERE id")) {
        const p = profiles.get(params[0] as string);
        return { first: p ? { created_at: p.created_at } : null };
      }
      if (sql.includes("FROM teacher_profiles WHERE user_id")) {
        const s = subjects.get(params[0] as string);
        return { first: s !== undefined ? { subjects_text: s } : null };
      }
      if (sql.includes("UPDATE profiles SET full_name")) {
        const p = profiles.get(params[1] as string);
        if (p) p.full_name = params[0] as string;
        return { changes: 1 };
      }
      if (sql.includes("INSERT INTO teacher_profiles")) {
        subjects.set(params[0] as string, params[1] as string);
        return { changes: 1 };
      }
      return {};
    });
    expect(await getMyProfileExtra(db, TEACHER)).toEqual({
      createdAt: "2026-10-01T00:00:00.000Z",
      subjectsText: "Math",
    });
    await updateMyFullName(db, TEACHER, "New Name");
    expect(profiles.get("teacher-1")?.full_name).toBe("New Name");
    await updateMySubject(db, TEACHER, "Physics");
    expect(subjects.get("teacher-1")).toBe("Physics");
    await expect(updateMySubject(db, STUDENT, "Physics")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

// ------------------------------------------------------------- reviews
function reviewsDb() {
  const submissions = new Map<
    string,
    { assessment_id: string; student_id: string; status: string }
  >([
    ["sub-own", { assessment_id: "assess-1", student_id: "student-1", status: "released" }],
    ["sub-draft", { assessment_id: "assess-1", student_id: "student-1", status: "submitted" }],
    ["sub-other", { assessment_id: "assess-1", student_id: "student-2", status: "released" }],
  ]);
  const assessments = new Map<string, string>([["assess-1", "teacher-1"]]);
  const questions = new Map<string, string>([
    ["q-1", "assess-1"],
    ["q-other", "assess-2"],
  ]);
  const requests = new Map<string, { teacher_id: string; student_id: string }>([
    ["req-1", { teacher_id: "teacher-1", student_id: "student-1" }],
    ["req-2", { teacher_id: "teacher-2", student_id: "student-2" }],
  ]);
  const db = fakeDb((sql, params) => {
    if (sql.includes("FROM submissions WHERE id")) {
      const s = submissions.get(params[0] as string);
      return {
        first: s
          ? { assessment_id: s.assessment_id, student_id: s.student_id, status: s.status }
          : null,
      };
    }
    if (sql.includes("FROM assessments WHERE id")) {
      const t = assessments.get(params[0] as string);
      return { first: t ? { teacher_id: t } : null };
    }
    if (sql.includes("FROM questions WHERE id")) {
      const a = questions.get(params[0] as string);
      return { first: a ? { assessment_id: a } : null };
    }
    if (sql.includes("INSERT INTO grade_review_requests")) return { changes: 1 };
    if (sql.includes("FROM grade_review_requests WHERE id")) {
      const r = requests.get(params[0] as string);
      return { first: r ? { teacher_id: r.teacher_id } : null };
    }
    if (sql.includes("UPDATE grade_review_requests")) return { changes: 1 };
    if (sql.includes("FROM grade_review_requests") && sql.includes("ORDER BY")) {
      const col = sql.includes("WHERE student_id") ? "student_id" : "teacher_id";
      const rows = [...requests.entries()]
        .filter(([, r]) => r[col as keyof typeof r] === params[0])
        .map(([id, r]) => ({ id, ...r }));
      return { all: rows };
    }
    return {};
  });
  return db;
}

describe("D1 grade reviews", () => {
  it("questions list requires the student's own released submission", async () => {
    const db = fakeDb((sql, params) => {
      if (sql.includes("FROM submissions WHERE assessment_id")) {
        return {
          first: params[0] === "assess-1" && params[1] === "student-1" ? { id: "sub-own" } : null,
        };
      }
      if (sql.includes("FROM questions WHERE assessment_id")) {
        return { all: [{ id: "q-1", prompt: "Explain" }] };
      }
      return {};
    });
    expect(await listQuestionsForReleasedAssessment(db, STUDENT, "assess-1")).toEqual([
      { id: "q-1", prompt: "Explain" },
    ]);
    await expect(
      listQuestionsForReleasedAssessment(db, STUDENT, "assess-forged"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a student cannot file for another student's submission or an unreleased one", async () => {
    const db = reviewsDb();
    await expect(
      submitReviewRequest(db, STUDENT, {
        submissionId: "sub-other",
        questionId: null,
        message: "why?",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      submitReviewRequest(db, STUDENT, {
        submissionId: "sub-draft",
        questionId: null,
        message: "why?",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      submitReviewRequest(db, STUDENT, {
        submissionId: "sub-own",
        questionId: "q-other",
        message: "why?",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const { id } = await submitReviewRequest(db, STUDENT, {
      submissionId: "sub-own",
      questionId: "q-1",
      message: "why?",
    });
    expect(typeof id).toBe("string");
  });

  it("only the owning teacher can resolve a request", async () => {
    const db = reviewsDb();
    expect(await resolveReviewRequest(db, TEACHER, "req-2", "ok")).toBe(false);
    expect(await resolveReviewRequest(db, TEACHER, "req-1", "ok")).toBe(true);
    await expect(resolveReviewRequest(db, STUDENT, "req-1", "ok")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const rows = await listReviewRequests(db, TEACHER);
    expect(rows.map((r) => r.id)).toEqual(["req-1"]);
  });
});
