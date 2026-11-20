/**
 * Tests for quickSettleSubmission (src/server/d1-grading.ts): the
 * one-click settle from the grading list. Uses a dispatch fake for
 * D1Database (same pattern as src/test/d1-grading.test.ts): mutations
 * apply on run()/batch() only, so the tests prove that a blocked
 * settle (a question the deterministic rule cannot grade) writes
 * nothing at all.
 */
import { describe, expect, it } from "vitest";
import { quickSettleSubmission } from "@/server/d1-grading";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type AnswerState = {
  id: string;
  submission_id: string;
  question_id: string;
  response: string;
  max_marks: number;
  auto_score: number | null;
  final_score: number | null;
  feedback: string;
  review_status: string;
};

type QuestionState = {
  id: string;
  type: string;
  marks: number;
  correct_answer: string | null;
  accepted_alternatives: string | null;
};

type State = {
  submissions: Record<string, { teacherId: string; assessmentId: string; status: string }>;
  questions: Record<string, QuestionState[]>;
  answers: AnswerState[];
  runs: { sql: string; params: unknown[] }[];
};

function fakeDb(state: State): D1Database {
  const stmt = (kind: string, sql: string, params: unknown[]): D1Statement => {
    const first = async <T>(): Promise<T | null> => {
      if (kind === "own-submission") {
        const sub = state.submissions[params[0] as string];
        if (!sub || sub.teacherId !== params[1]) return null;
        return {
          id: params[0],
          assessment_id: sub.assessmentId,
          status: sub.status,
        } as unknown as T;
      }
      if (kind === "released-submission") {
        const sub = state.submissions[params[0] as string];
        if (!sub) return null;
        return { student_id: "student-a", title: "Exam 1" } as unknown as T;
      }
      if (kind === "ungated") {
        const submissionId = params[0] as string;
        const assessmentId = params[1] as string;
        const questions = state.questions[assessmentId] ?? [];
        const blocked = questions.some((q) => {
          const a = state.answers.find(
            (x) => x.submission_id === submissionId && x.question_id === q.id,
          );
          return !a || a.final_score === null || a.final_score < 0 || a.final_score > q.marks;
        });
        return (blocked ? { one: 1 } : null) as unknown as T | null;
      }
      if (kind === "totals") {
        const submissionId = params[0] as string;
        const assessmentId = params[1] as string;
        const questions = state.questions[assessmentId] ?? [];
        let total = 0;
        let possible = 0;
        for (const q of questions) {
          possible += q.marks;
          const a = state.answers.find(
            (x) => x.submission_id === submissionId && x.question_id === q.id,
          );
          total += a?.final_score ?? 0;
        }
        return { total, possible } as unknown as T;
      }
      return null;
    };
    const all = async <T>(): Promise<{ results?: T[] }> => {
      if (kind === "settle-questions") {
        const rows = state.questions[params[0] as string] ?? [];
        return { results: rows as unknown as T[] };
      }
      if (kind === "settle-answers") {
        const rows = state.answers.filter((a) => a.submission_id === params[0]);
        return { results: rows as unknown as T[] };
      }
      return { results: [] };
    };
    // Mutations apply on run() (and batch() runs each statement), so a
    // settle that throws mid-way leaves the state untouched — matching
    // real D1, where the collected batch never executes.
    const run = async () => {
      state.runs.push({ sql, params });
      if (sql.startsWith("UPDATE answers SET auto_score")) {
        const row = state.answers.find((a) => a.id === params[2] && a.submission_id === params[3]);
        if (row) {
          row.auto_score = params[0] as number;
          row.final_score = params[1] as number;
          row.review_status = "auto_graded";
        }
      } else if (sql.startsWith("INSERT INTO answers")) {
        state.answers.push({
          id: params[0] as string,
          submission_id: params[1] as string,
          question_id: params[2] as string,
          response: "",
          max_marks: params[3] as number,
          auto_score: params[4] as number,
          final_score: params[5] as number,
          feedback: "",
          review_status: "auto_graded",
        });
      } else if (sql.startsWith("UPDATE submissions SET status = 'approved'")) {
        // quickSettle's flip inlines the status; the id is the only bind.
        const sub = state.submissions[params[0] as string];
        if (sub) sub.status = "approved";
      } else if (sql.startsWith("UPDATE submissions SET status = ?")) {
        const sub = state.submissions[params[1] as string];
        if (sub) sub.status = params[0] as string;
      } else if (sql.startsWith("UPDATE submissions SET final_score")) {
        const sub = state.submissions[params[4] as string];
        if (sub) sub.status = "released";
      }
      return undefined;
    };
    return { bind: () => stmt(kind, sql, params), first, all, run } as unknown as D1Statement;
  };
  const db = {
    prepare(sql: string): D1Statement {
      let kind = "unknown";
      if (sql.includes("FROM submissions s JOIN assessments a") && sql.includes("a.teacher_id"))
        kind = "own-submission";
      else if (sql.includes("FROM submissions s JOIN assessments a")) kind = "released-submission";
      else if (sql.includes("FROM questions q LEFT JOIN question_keys")) kind = "settle-questions";
      else if (sql.startsWith("SELECT id, question_id, response, final_score FROM answers"))
        kind = "settle-answers";
      else if (sql.includes("LEFT JOIN answers an") && sql.includes("an.final_score IS NULL"))
        kind = "ungated";
      else if (sql.includes("SUM(an.final_score)")) kind = "totals";
      let params: unknown[] = [];
      const base = stmt(kind, sql, params);
      return {
        bind: (...p: unknown[]) => {
          params = p;
          return stmt(kind, sql, params);
        },
        first: base.first,
        all: base.all,
        run: base.run,
      } as unknown as D1Statement;
    },
    batch: async (statements: D1Statement[]) => {
      for (const s of statements) await s.run();
      return [];
    },
  };
  return db as unknown as D1Database;
}

function baseState(): State {
  return {
    submissions: {
      "sub-1": { teacherId: "teacher-1", assessmentId: "ex1", status: "awaiting_review" },
    },
    questions: {
      ex1: [
        { id: "q1", type: "mcq", marks: 5, correct_answer: "4", accepted_alternatives: "[]" },
        { id: "q2", type: "mcq", marks: 5, correct_answer: "y", accepted_alternatives: "[]" },
        {
          id: "q3",
          type: "short_answer",
          marks: 5,
          correct_answer: "World",
          accepted_alternatives: "[]",
        },
      ],
    },
    answers: [
      {
        id: "a1",
        submission_id: "sub-1",
        question_id: "q1",
        response: "4",
        max_marks: 5,
        auto_score: null,
        final_score: null,
        feedback: "",
        review_status: "not_graded",
      },
      {
        id: "a2",
        submission_id: "sub-1",
        question_id: "q2",
        response: "x",
        max_marks: 5,
        auto_score: null,
        final_score: null,
        feedback: "",
        review_status: "not_graded",
      },
      // q3 has no answer row at all: the student never touched it.
    ],
    runs: [],
  };
}

describe("d1-grading: quick settle", () => {
  it("auto-grades what is unscored, inserts missing answers as zeros, and releases with canonical totals", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const result = await quickSettleSubmission(db, "teacher-1", "sub-1");
    expect(result).toEqual({
      finalScore: 5, // q1 correct (5), q2 wrong (0), q3 untouched (0)
      totalPossible: 15,
      assessmentId: "ex1",
      studentId: "student-a",
    });
    expect(state.submissions["sub-1"]?.status).toBe("released");
    expect(state.answers.find((a) => a.id === "a1")?.final_score).toBe(5);
    expect(state.answers.find((a) => a.id === "a2")?.final_score).toBe(0);
    const inserted = state.answers.find((a) => a.question_id === "q3");
    expect(inserted?.final_score).toBe(0);
    expect(inserted?.review_status).toBe("auto_graded");
    // The release goes through the normal audited path.
    expect(state.runs.some((r) => r.sql.startsWith("INSERT INTO audit_log"))).toBe(true);
  });

  it("keeps a teacher-set score and promotes only the unscored questions", async () => {
    const state = baseState();
    const a1 = state.answers.find((a) => a.id === "a1")!;
    a1.final_score = 3; // the teacher overrode the auto 5 earlier
    const db = fakeDb(state);
    const result = await quickSettleSubmission(db, "teacher-1", "sub-1");
    expect(result.finalScore).toBe(3); // 3 (teacher) + 0 + 0
    expect(state.answers.find((a) => a.id === "a1")?.final_score).toBe(3);
  });

  it("a written question blocks the settle with NOT_FULLY_GRADABLE and writes nothing", async () => {
    const state = baseState();
    state.questions["ex1"] = [
      { id: "q1", type: "mcq", marks: 5, correct_answer: "4", accepted_alternatives: "[]" },
      { id: "qw", type: "written", marks: 10, correct_answer: null, accepted_alternatives: null },
    ];
    const db = fakeDb(state);
    await expect(quickSettleSubmission(db, "teacher-1", "sub-1")).rejects.toThrow(
      "NOT_FULLY_GRADABLE",
    );
    // Nothing was written: no answer changed, no release, no audit row.
    expect(state.runs).toEqual([]);
    expect(state.answers.every((a) => a.final_score === null)).toBe(true);
    expect(state.submissions["sub-1"]?.status).toBe("awaiting_review");
  });

  it("an unkeyed objective question also blocks the settle", async () => {
    const state = baseState();
    state.questions["ex1"] = [
      { id: "q1", type: "mcq", marks: 5, correct_answer: null, accepted_alternatives: null },
    ];
    state.answers = [];
    const db = fakeDb(state);
    await expect(quickSettleSubmission(db, "teacher-1", "sub-1")).rejects.toThrow(
      "NOT_FULLY_GRADABLE",
    );
    expect(state.runs).toEqual([]);
  });

  it("an approved submission with every question scored releases without touching any answer", async () => {
    const state = baseState();
    state.submissions["sub-1"]!.status = "approved";
    state.answers = state.answers.map((a) => ({ ...a, final_score: 4 }));
    state.answers.push({
      id: "a3",
      submission_id: "sub-1",
      question_id: "q3",
      response: "world",
      max_marks: 5,
      auto_score: null,
      final_score: 5,
      feedback: "",
      review_status: "approved",
    });
    const db = fakeDb(state);
    const result = await quickSettleSubmission(db, "teacher-1", "sub-1");
    expect(result.finalScore).toBe(13); // 4 + 4 + 5
    expect(state.submissions["sub-1"]?.status).toBe("released");
    expect(state.runs.some((r) => r.sql.startsWith("UPDATE answers"))).toBe(false);
    expect(state.runs.some((r) => r.sql.startsWith("INSERT INTO answers"))).toBe(false);
  });

  it("refuses a released submission and a submission owned by another teacher", async () => {
    const state = baseState();
    state.submissions["sub-rel"] = {
      teacherId: "teacher-1",
      assessmentId: "ex1",
      status: "released",
    };
    const db = fakeDb(state);
    await expect(quickSettleSubmission(db, "teacher-1", "sub-rel")).rejects.toThrow(
      "NOT_READY_FOR_REVIEW",
    );
    await expect(quickSettleSubmission(db, "teacher-2", "sub-1")).rejects.toThrow("NOT_FOUND");
  });
});
