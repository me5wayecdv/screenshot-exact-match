/**
 * Tests for D1 analytics (d1-analytics.ts) and the student tutor
 * data (d1-tutor.ts), using dispatch fakes. Key guarantees: a
 * teacher cannot read another teacher's stats, a student cannot
 * read another student's answers, tutor queries never select
 * question_keys, and a practice draft copies only the caller's own
 * questions by id — answer keys never reach the browser, a foreign
 * question id is rejected, and a forged question array or subject
 * id supplied by the client is ignored.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PRACTICE_QUESTIONS,
  createPracticeDraft,
  getAnalyticsDetail,
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
  // assess-1 belongs to teacher-1 (subject subj-1, grade 3);
  // assess-2 belongs to teacher-2. q-1/q-2 are assess-1's questions,
  // q-foreign is assess-2's — it exists in the DB but is not the
  // caller's, so the practice re-read must not return it.
  const sources = new Map<string, { teacher_id: string; subject_id: string; grade_level: string }>([
    ["assess-1", { teacher_id: "teacher-1", subject_id: "subj-1", grade_level: "3" }],
    ["assess-2", { teacher_id: "teacher-2", subject_id: "subj-2", grade_level: "5" }],
  ]);
  const questions = new Map<
    string,
    { assessment_id: string; type: string; prompt: string; marks: number; key: string }
  >([
    [
      "q-1",
      { assessment_id: "assess-1", type: "written", prompt: "Explain", marks: 10, key: "key" },
    ],
    [
      "q-2",
      { assessment_id: "assess-1", type: "written", prompt: "Define", marks: 5, key: "key-2" },
    ],
    [
      "q-foreign",
      { assessment_id: "assess-2", type: "written", prompt: "Other", marks: 10, key: "key-3" },
    ],
  ]);
  const inserts = {
    assessments: [] as string[],
    assessmentParams: [] as unknown[][],
    questions: 0,
    questionParams: [] as unknown[][],
    keys: 0,
    keyParams: [] as unknown[][],
    audit: [] as { action: unknown; details: unknown }[],
  };
  return {
    inserts,
    db: fakeDb((sql, params) => {
      // Post-write existence check (must precede the generic owner
      // branch: both match "FROM assessments WHERE id").
      if (sql.startsWith("SELECT id FROM assessments WHERE id")) {
        const id = params[0] as string;
        return { first: inserts.assessments.includes(id) ? { id } : null };
      }
      if (sql.includes("SELECT COUNT(*) AS n FROM questions")) {
        return { first: { n: inserts.questions } };
      }
      if (sql.includes("FROM assessments WHERE id")) {
        const s = sources.get(params[0] as string);
        return { first: s ?? null };
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
      // Practice re-read: the caller's own rows only. Params are
      // [callerId, assessmentId, ...questionIds]; a question from
      // another teacher's assessment is filtered out here, so the
      // found.length check in createPracticeDraft rejects the call.
      if (
        sql.includes("FROM questions q JOIN assessments own") &&
        sql.includes("LEFT JOIN question_keys")
      ) {
        const assessmentId = params[1] as string;
        const ids = params.slice(2) as string[];
        return {
          all: ids
            .map((id) => questions.get(id))
            .filter(
              (q): q is NonNullable<typeof q> =>
                q !== undefined && q.assessment_id === assessmentId,
            )
            .map((q) => ({
              id: [...questions.entries()].find(([, v]) => v === q)![0],
              type: q.type,
              prompt: q.prompt,
              marks: q.marks,
              objective: "obj",
              options: "[]",
              difficulty: "medium",
              correct_answer: q.key,
              accepted_alternatives: "[]",
              rubric: "r",
              explanation: "e",
            })),
        };
      }
      if (sql.includes("INSERT INTO assessments")) {
        inserts.assessments.push(params[0] as string);
        inserts.assessmentParams.push([...params]);
        return { changes: 1 };
      }
      if (sql.includes("INSERT INTO questions")) {
        inserts.questions += 1;
        inserts.questionParams.push([...params]);
        return { changes: 1 };
      }
      if (sql.includes("INSERT INTO question_keys")) {
        inserts.keys += 1;
        inserts.keyParams.push([...params]);
        return { changes: 1 };
      }
      if (sql.includes("INSERT INTO audit_log")) {
        inserts.audit.push({ action: params[1], details: params[3] });
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

  it("practice draft copies the caller's own questions by id and writes an audit row", async () => {
    const { db, inserts } = analyticsDb();
    const result = await createPracticeDraft(db, TEACHER, {
      assessmentId: "assess-1",
      questionIds: ["q-1"],
      title: "Practice: assess-1",
    });
    expect(typeof result.id).toBe("string");
    expect(result.copied).toBe(1);
    // No answer-key material in anything returned to the caller.
    expect(JSON.stringify(result)).not.toContain("correct_answer");
    expect(JSON.stringify(result)).not.toContain("key");
    // The draft is a draft, and its subject/grade come from the
    // server's own source row — the client supplies neither.
    expect(inserts.assessments).toHaveLength(1);
    expect(inserts.assessmentParams[0]?.[1]).toBe("teacher-1");
    expect(inserts.assessmentParams[0]?.[2]).toBe("subj-1");
    expect(inserts.assessmentParams[0]?.[4]).toBe("3");
    // The copied question and key are the server's rows, not the
    // client's, and the audit row records the copy.
    expect(inserts.questions).toBe(1);
    expect(inserts.questionParams[0]?.[4]).toBe("Explain");
    expect(inserts.keys).toBe(1);
    expect(inserts.keyParams[0]?.[1]).toBe("key");
    expect(inserts.audit).toHaveLength(1);
    expect(inserts.audit[0]?.action).toBe("analytics.practice_draft");
    expect(JSON.parse(String(inserts.audit[0]?.details))).toEqual({
      sourceAssessmentId: "assess-1",
      copied: 1,
    });
  });

  it("the key-returning practice source endpoint no longer exists", async () => {
    const ns = (await import("@/server/d1-analytics")) as Record<string, unknown>;
    expect("getPracticeSource" in ns).toBe(false);
    expect("getPracticeSourceD1" in ns).toBe(false);
    expect("PracticeQuestionInput" in ns).toBe(false);
  });

  it("a question from another teacher's assessment is rejected", async () => {
    const { db, inserts } = analyticsDb();
    await expect(
      createPracticeDraft(db, TEACHER, {
        assessmentId: "assess-1",
        questionIds: ["q-1", "q-foreign"],
        title: "Practice: assess-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(inserts.assessments).toHaveLength(0);
    expect(inserts.questions).toBe(0);
    expect(inserts.audit).toHaveLength(0);
  });

  it("a foreign assessment and a non-teacher caller are rejected", async () => {
    const { db, inserts } = analyticsDb();
    await expect(
      createPracticeDraft(db, OTHER_TEACHER, {
        assessmentId: "assess-1",
        questionIds: ["q-1"],
        title: "Practice: assess-1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      createPracticeDraft(
        db,
        { id: "student-1", role: "student" },
        {
          assessmentId: "assess-1",
          questionIds: ["q-1"],
          title: "Practice: assess-1",
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inserts.assessments).toHaveLength(0);
  });

  it("more than MAX_PRACTICE_QUESTIONS ids, duplicate-stuffed ids, and an empty list are rejected", async () => {
    const { db, inserts } = analyticsDb();
    const tooMany = Array.from({ length: MAX_PRACTICE_QUESTIONS + 1 }, (_, i) => `q-${i}`);
    await expect(
      createPracticeDraft(db, TEACHER, {
        assessmentId: "assess-1",
        questionIds: tooMany,
        title: "Practice: assess-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // 21 copies of one id is still oversized (raw length is checked
    // before de-duplication).
    await expect(
      createPracticeDraft(db, TEACHER, {
        assessmentId: "assess-1",
        questionIds: Array.from({ length: MAX_PRACTICE_QUESTIONS + 1 }, () => "q-1"),
        title: "Practice: assess-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      createPracticeDraft(db, TEACHER, {
        assessmentId: "assess-1",
        questionIds: [],
        title: "Practice: assess-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(inserts.assessments).toHaveLength(0);
  });

  it("a forged question array and a wrong subjectId are ignored", async () => {
    const { db, inserts } = analyticsDb();
    // Old-shape body: a full client-supplied question array with a
    // forged key, plus a subject the caller does not own. The new
    // signature takes ids only, so all of it must be ignored and the
    // draft must carry the server's own rows.
    const forged = {
      assessmentId: "assess-1",
      questionIds: ["q-1"],
      title: "Practice: assess-1",
      subjectId: "forged-subject",
      gradeLevel: "9",
      questions: [
        {
          id: "q-1",
          type: "written",
          prompt: "FORGED PROMPT",
          marks: 999,
          objective: "forged",
          options: [],
          difficulty: "hard",
          key: {
            correct_answer: "FORGED-KEY",
            accepted_alternatives: [],
            rubric: "forged",
            explanation: "forged",
          },
        },
      ],
    } as unknown as { assessmentId: string; questionIds: string[]; title: string };
    const result = await createPracticeDraft(db, TEACHER, forged);
    expect(result.copied).toBe(1);
    expect(inserts.assessmentParams[0]?.[2]).toBe("subj-1");
    expect(inserts.assessmentParams[0]?.[4]).toBe("3");
    expect(inserts.questionParams[0]?.[4]).toBe("Explain");
    expect(inserts.questionParams[0]?.[5]).toBe(10);
    expect(inserts.keyParams[0]?.[1]).toBe("key");
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
