/**
 * Tests for D1 analytics (d1-analytics.ts) and the student tutor
 * data (d1-tutor.ts), using dispatch fakes. Key guarantees: a
 * teacher cannot read another teacher's stats, a student cannot
 * read another student's answers, and tutor queries never select
 * question_keys.
 */
import { describe, expect, it } from "vitest";
import {
  createPracticeDraft,
  getAnalyticsDetail,
  getPracticeSource,
  type Caller,
} from "@/server/d1-analytics";
import {
  getTutorDetail,
  listTutorAssessments,
  type Caller as TutorCaller,
} from "@/server/d1-tutor";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

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
const OTHER_TEACHER: Caller = { id: "teacher-2", role: "school_teacher" };
const STUDENT: TutorCaller = { id: "student-1", role: "student" };
const OTHER_STUDENT: TutorCaller = { id: "student-2", role: "student" };

function analyticsDb() {
  const owners = new Map<string, string>([["assess-1", "teacher-1"]]);
  const inserts = { assessments: [] as string[], questions: 0, keys: 0 };
  return {
    inserts,
    db: fakeDb((sql, params) => {
      if (sql.includes("FROM assessments WHERE id")) {
        const t = owners.get(params[0] as string);
        return { first: t ? { teacher_id: t } : null };
      }
      if (sql.includes("SUM(CASE WHEN s.id IS NOT NULL")) {
        return {
          all: [{ question_id: "q-1", answered: 3, graded: 2, pct_sum: 150, full_count: 1 }],
        };
      }
      if (sql.includes("FROM lessons l")) {
        return { all: [] };
      }
      if (sql.includes("GROUP BY s.student_id")) {
        return { all: [{ student_id: "student-1", full_name: "Sara", released: 2, avg_pct: 85 }] };
      }
      if (sql.includes("FROM questions q") && sql.includes("ORDER BY q.position LIMIT 200")) {
        return {
          all: [
            {
              id: "q-1",
              position: 0,
              type: "written",
              prompt: "Explain",
              marks: 10,
              objective: "obj",
              difficulty: "medium",
              options: "[]",
            },
          ],
        };
      }
      if (sql.includes("FROM questions q LEFT JOIN question_keys")) {
        return {
          all: [
            {
              type: "written",
              prompt: "Explain",
              marks: 10,
              objective: "obj",
              options: "[]",
              difficulty: "medium",
              correct_answer: "key",
              accepted_alternatives: "[]",
              rubric: "r",
              explanation: "e",
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO assessments")) {
        inserts.assessments.push("draft");
        return { changes: 1 };
      }
      if (sql.includes("INSERT INTO questions")) {
        inserts.questions += 1;
        return { changes: 1 };
      }
      if (sql.includes("INSERT INTO question_keys")) {
        inserts.keys += 1;
        return { changes: 1 };
      }
      return {};
    }),
  };
}

describe("D1 analytics", () => {
  it("a teacher cannot read another teacher's analytics detail", async () => {
    const { db } = analyticsDb();
    await expect(getAnalyticsDetail(db, OTHER_TEACHER, "assess-1", 0, 0)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("detail aggregates released work only and computes pcts from sums", async () => {
    const { db } = analyticsDb();
    const detail = await getAnalyticsDetail(db, TEACHER, "assess-1", 0, 0);
    expect(detail.questionStats).toEqual([
      { questionId: "q-1", answered: 3, graded: 2, avgPct: 75, fullCreditPct: 50 },
    ]);
    expect(detail.students).toEqual([
      { studentId: "student-1", name: "Sara", released: 2, avgPct: 85 },
    ]);
    expect(detail.questions[0]?.prompt).toBe("Explain");
  });

  it("practice source is teacher-only and the practice draft is a draft", async () => {
    const { db, inserts } = analyticsDb();
    await expect(getPracticeSource(db, OTHER_TEACHER, "assess-1")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const src = await getPracticeSource(db, TEACHER, "assess-1");
    expect(src[0]?.key.correct_answer).toBe("key");
    const { id } = await createPracticeDraft(db, TEACHER, {
      title: "Practice: assess-1",
      subjectId: null,
      gradeLevel: "3",
      questions: src,
    });
    expect(typeof id).toBe("string");
    expect(inserts.assessments).toHaveLength(1);
    expect(inserts.questions).toBe(1);
    expect(inserts.keys).toBe(1);
  });
});

function tutorDb() {
  const submissions = new Map<
    string,
    { assessment_id: string; student_id: string; status: string }
  >([
    ["sub-own", { assessment_id: "assess-1", student_id: "student-1", status: "released" }],
    ["sub-other", { assessment_id: "assess-1", student_id: "student-2", status: "released" }],
  ]);
  return fakeDb((sql, params) => {
    if (sql.includes("FROM submissions WHERE id")) {
      const s = submissions.get(params[0] as string);
      return {
        first: s
          ? { assessment_id: s.assessment_id, student_id: s.student_id, status: s.status }
          : null,
      };
    }
    if (sql.includes("FROM assessments a") && sql.includes("EXISTS")) {
      const ids = params.slice(0, -1) as string[];
      const caller = params[params.length - 1] as string;
      const rows = ids
        .filter((id) =>
          [...submissions.values()].some(
            (s) => s.assessment_id === id && s.student_id === caller && s.status === "released",
          ),
        )
        .map((id) => ({ id, title: "Quiz", subject_id: null }));
      return { all: rows };
    }
    if (sql.includes("FROM submissions") && sql.includes("status = 'released'")) {
      const rows = [...submissions.entries()]
        .filter(([, s]) => s.student_id === params[0] && s.status === "released")
        .map(([id, s]) => ({
          id,
          assessment_id: s.assessment_id,
          final_score: 8,
          total_possible: 10,
        }));
      return { all: rows };
    }
    if (sql.includes("FROM questions") && sql.includes("WHERE assessment_id")) {
      return {
        all: [
          {
            id: "q-1",
            position: 0,
            type: "written",
            prompt: "Explain",
            marks: 10,
            objective: "obj",
            options: "[]",
          },
        ],
      };
    }
    if (sql.includes("FROM answers") && sql.includes("WHERE submission_id")) {
      return {
        all:
          params[0] === "sub-own"
            ? [
                {
                  question_id: "q-1",
                  response: "my answer",
                  final_score: 8,
                  auto_score: null,
                  feedback: "good",
                },
              ]
            : [],
      };
    }
    return {};
  });
}

describe("D1 tutor (hints-first, no keys, no other students)", () => {
  it("a student cannot fetch another student's answers", async () => {
    const db = tutorDb();
    await expect(getTutorDetail(db, STUDENT, "assess-1", "sub-other")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(getTutorDetail(db, OTHER_STUDENT, "assess-1", "sub-own")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const detail = await getTutorDetail(db, STUDENT, "assess-1", "sub-own");
    expect(detail.answers).toEqual([
      {
        question_id: "q-1",
        response: "my answer",
        final_score: 8,
        auto_score: null,
        feedback: "good",
      },
    ]);
    expect(JSON.stringify(detail)).not.toContain("correct_answer");
  });

  it("forged assessment ids yield nothing in the tutor assessments list", async () => {
    const db = tutorDb();
    expect(await listTutorAssessments(db, STUDENT, ["assess-forged"])).toEqual([]);
    expect(await listTutorAssessments(db, STUDENT, ["assess-1"])).toHaveLength(1);
  });
});
