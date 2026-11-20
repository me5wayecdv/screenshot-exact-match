/**
 * Tests for the D1 grading server functions (src/server/d1-grading.ts).
 * Uses a dispatch fake for D1Database (same pattern as
 * src/test/d1-take-gate.test.ts): in-memory rows, every SQL string
 * recorded, so the tests prove the teacher-ownership checks, the
 * release gate, and the student-denial rules without a Worker
 * binding or a live D1.
 */
import { describe, expect, it } from "vitest";
import {
  autoScoreFor,
  getGradingDetail,
  listGradingPage,
  releaseSubmission,
  reviewAnswer,
  setAutoScores,
} from "@/server/d1-grading";
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

type State = {
  // submissionId -> { teacherId, assessmentId, status }
  submissions: Record<string, { teacherId: string; assessmentId: string; status: string }>;
  questions: Record<string, { id: string; marks: number }[]>; // assessmentId -> questions
  answers: AnswerState[];
  seen: string[];
  runs: { sql: string; params: unknown[] }[];
};

function fakeDb(state: State): D1Database {
  const stmt = (kind: string, params: unknown[]): D1Statement => {
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
      if (kind === "answer") {
        const row = state.answers.find((a) => a.id === params[0]);
        return (row ?? null) as unknown as T | null;
      }
      if (kind === "answer-grading-state") {
        const row = state.answers.find((a) => a.id === params[0] && a.submission_id === params[1]);
        return (row
          ? {
              auto_score: row.auto_score,
              final_score: row.final_score,
              review_status: row.review_status,
            }
          : null) as unknown as T | null;
      }
      if (kind === "question-marks") {
        const rows = Object.values(state.questions).flat();
        const q = rows.find((r) => r.id === params[0]);
        return (q ? { marks: q.marks } : null) as unknown as T | null;
      }
      if (kind === "pending") {
        const assessmentId = params[0] as string;
        const submissionId = params[1] as string;
        const questions = state.questions[assessmentId] ?? [];
        const pending = state.answers.some(
          (a) =>
            a.submission_id === submissionId &&
            questions.some((q) => q.id === a.question_id) &&
            a.final_score === null,
        );
        return (pending ? { one: 1 } : null) as unknown as T | null;
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
      if (kind === "grading-list") {
        // Only the owning teacher's rows are ever returned.
        if (params[0] !== "teacher-1") return { results: [] };
        return {
          results: [
            {
              id: "sub-1",
              assessment_id: "ex1",
              student_id: "student-a",
              status: "awaiting_review",
              attempt_number: 1,
              submitted_at: "2026-11-03T19:00:00.000Z",
              final_score: null,
              total_possible: 10,
              assessment_title: "Exam 1",
              student_name: "Student A",
              objective_only: 1,
              unscored_count: 2,
            },
          ] as unknown as T[],
        };
      }
      if (kind === "detail-questions") {
        const rows = state.questions[params[0] as string] ?? [];
        return {
          results: rows.map((q) => ({
            id: q.id,
            prompt: `Q ${q.id}`,
            type: "mcq",
            marks: q.marks,
            position: 0,
            correct_answer: "4",
            accepted_alternatives: "[]",
            rubric: "",
            explanation: "",
          })) as unknown as T[],
        };
      }
      if (kind === "detail-answers") {
        const rows = state.answers.filter((a) => a.submission_id === params[0]);
        return { results: rows as unknown as T[] };
      }
      return { results: [] };
    };
    return {
      bind: () => stmt(kind, params),
      first,
      all,
      run: async () => undefined,
    } as unknown as D1Statement;
  };
  return {
    prepare(sql: string): D1Statement {
      state.seen.push(sql);
      let kind = "unknown";
      if (sql.includes("FROM submissions s JOIN assessments a") && sql.includes("WHERE s.id = ?")) {
        // ownSubmission also filters on the owning teacher; the
        // post-release activity-label lookup does not.
        kind = sql.includes("a.teacher_id") ? "own-submission" : "released-submission";
      } else if (
        sql.includes("FROM submissions s JOIN assessments a") &&
        sql.includes("ORDER BY s.submitted_at")
      )
        kind = "grading-list";
      else if (sql.startsWith("SELECT * FROM answers WHERE id = ?")) kind = "answer";
      else if (sql.startsWith("SELECT auto_score, final_score, review_status FROM answers"))
        kind = "answer-grading-state";
      else if (sql.includes("SELECT marks FROM questions")) kind = "question-marks";
      else if (sql.includes("FROM answers an JOIN questions q")) kind = "pending";
      else if (sql.includes("LEFT JOIN answers an") && sql.includes("an.final_score IS NULL"))
        kind = "ungated";
      else if (sql.includes("SUM(an.final_score)")) kind = "totals";
      else if (sql.includes("FROM questions q LEFT JOIN question_keys")) kind = "detail-questions";
      else if (sql.startsWith("SELECT * FROM answers WHERE submission_id = ?"))
        kind = "detail-answers";
      let params: unknown[] = [];
      const base = stmt(kind, params);
      return {
        bind: (...p: unknown[]) => {
          params = p;
          if (sql.startsWith("UPDATE answers SET max_marks")) {
            const row = state.answers.find((a) => a.id === p[4]);
            if (row) {
              row.max_marks = p[0] as number;
              row.final_score = p[1] as number | null;
              row.feedback = p[2] as string;
              row.review_status = p[3] as string;
            }
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("UPDATE answers SET auto_score = ?, final_score = ?")) {
            const row = state.answers.find((a) => a.id === p[2]);
            if (row) {
              row.auto_score = p[0] as number;
              row.final_score = p[1] as number;
              row.review_status = "auto_graded";
            }
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("UPDATE answers SET auto_score = ?")) {
            const row = state.answers.find((a) => a.id === p[1]);
            if (row) row.auto_score = p[0] as number;
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("UPDATE submissions SET status = ?")) {
            const sub = state.submissions[p[1] as string];
            if (sub) sub.status = p[0] as string;
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("UPDATE submissions SET final_score")) {
            const sub = state.submissions[p[4] as string];
            if (sub) sub.status = "released";
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("INSERT INTO audit_log")) {
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
    submissions: {
      "sub-1": { teacherId: "teacher-1", assessmentId: "ex1", status: "awaiting_review" },
      "sub-approved": { teacherId: "teacher-1", assessmentId: "ex1", status: "approved" },
    },
    questions: {
      ex1: [
        { id: "q1", marks: 5 },
        { id: "q2", marks: 5 },
      ],
    },
    answers: [
      {
        id: "a1",
        submission_id: "sub-1",
        question_id: "q1",
        response: "4",
        max_marks: 5,
        auto_score: 5,
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
    ],
    seen: [],
    runs: [],
  };
}

describe("d1-grading: ownership", () => {
  it("a non-owner teacher cannot read, grade, or release another teacher's submission", async () => {
    const db = fakeDb(baseState());
    await expect(getGradingDetail(db, "teacher-2", "sub-1")).rejects.toThrow("NOT_FOUND");
    await expect(reviewAnswer(db, "teacher-2", "a1", 5, "", "approve")).rejects.toThrow(
      "NOT_FOUND",
    );
    await expect(releaseSubmission(db, "teacher-2", "sub-approved", "")).rejects.toThrow(
      "NOT_FOUND",
    );
  });

  it("a student request for a submission is denied before any answer or key row is returned", async () => {
    const state = baseState();
    const db = fakeDb(state);
    // A student is never the owning teacher, so the ownership check
    // throws before the detail queries run at all.
    await expect(getGradingDetail(db, "student-a", "sub-1")).rejects.toThrow("NOT_FOUND");
    expect(state.seen.some((sql) => sql.includes("FROM answers"))).toBe(false);
    expect(state.seen.some((sql) => sql.includes("question_keys"))).toBe(false);
  });

  it("the grading list shows only the owning teacher's submissions", async () => {
    const db = fakeDb(baseState());
    const own = await listGradingPage(db, "teacher-1", "awaiting_review", 0, 30);
    expect(own.submissions.map((s) => s.id)).toEqual(["sub-1"]);
    expect(own.submissions[0]?.assessmentTitle).toBe("Exam 1");
    // Quick-settle metadata rides along for the row action button.
    expect(own.submissions[0]?.objectiveOnly).toBe(true);
    expect(own.submissions[0]?.unscoredCount).toBe(2);
    const other = await listGradingPage(db, "teacher-2", "awaiting_review", 0, 30);
    expect(other.submissions).toEqual([]);
  });
});

describe("d1-grading: review and release gate", () => {
  it("review rejects a score outside the question's marks", async () => {
    const db = fakeDb(baseState());
    await expect(reviewAnswer(db, "teacher-1", "a1", 99, "", "approve")).rejects.toThrow(
      "SCORE_OUT_OF_RANGE",
    );
  });

  it("reviewing every answer flips the submission to approved; a reject reopens it", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await reviewAnswer(db, "teacher-1", "a1", 5, "good", "approve");
    expect(state.submissions["sub-1"]?.status).toBe("awaiting_review"); // a2 still unscored
    await reviewAnswer(db, "teacher-1", "a2", 3, "ok", "approve");
    expect(state.submissions["sub-1"]?.status).toBe("approved");
    await reviewAnswer(db, "teacher-1", "a2", null, "redo", "reject");
    expect(state.submissions["sub-1"]?.status).toBe("awaiting_review");
    expect(state.answers.find((a) => a.id === "a2")?.final_score).toBeNull();
  });

  it("release is blocked until every question has a teacher score", async () => {
    const state = baseState();
    const db = fakeDb(state);
    // sub-approved is 'approved' but its answers are unscored (no rows
    // for it in this fixture), so the gate must block.
    await expect(releaseSubmission(db, "teacher-1", "sub-approved", "")).rejects.toThrow(
      "NOT_FULLY_GRADED",
    );
    expect(state.runs.some((r) => r.sql.includes("status = 'released'"))).toBe(false);
  });

  it("release is blocked while the submission is not approved, even if scored", async () => {
    const state = baseState();
    state.answers.forEach((a) => {
      if (a.submission_id === "sub-1") a.final_score = 5;
    });
    const db = fakeDb(state);
    await expect(releaseSubmission(db, "teacher-1", "sub-1", "")).rejects.toThrow("NOT_APPROVED");
  });

  it("release succeeds once approved and fully scored, with canonical totals", async () => {
    const state = baseState();
    state.submissions["sub-1"]!.status = "approved";
    state.answers.forEach((a) => {
      if (a.submission_id === "sub-1") a.final_score = a.question_id === "q1" ? 5 : 3;
    });
    const db = fakeDb(state);
    const result = await releaseSubmission(db, "teacher-1", "sub-1", "");
    expect(result).toEqual({
      finalScore: 8,
      totalPossible: 10,
      assessmentId: "ex1",
      studentId: "student-a",
    });
    expect(state.submissions["sub-1"]?.status).toBe("released");
  });
});

describe("d1-grading: re-grading released submissions (grade-review flow)", () => {
  function releasedState(): State {
    const state = baseState();
    state.submissions["sub-rel"] = {
      teacherId: "teacher-1",
      assessmentId: "ex1",
      status: "released",
    };
    state.answers.push(
      {
        id: "a3",
        submission_id: "sub-rel",
        question_id: "q1",
        response: "4",
        max_marks: 5,
        auto_score: 5,
        final_score: 5,
        feedback: "",
        review_status: "approved",
      },
      {
        id: "a4",
        submission_id: "sub-rel",
        question_id: "q2",
        response: "x",
        max_marks: 5,
        auto_score: null,
        final_score: 2,
        feedback: "",
        review_status: "approved",
      },
    );
    return state;
  }

  it("a corrected score on a released submission updates in place and stays released", async () => {
    const state = releasedState();
    const db = fakeDb(state);
    await reviewAnswer(db, "teacher-1", "a4", 4, "corrected", "approve");
    expect(state.answers.find((a) => a.id === "a4")?.final_score).toBe(4);
    expect(state.submissions["sub-rel"]?.status).toBe("released");
    // Canonical totals refreshed on the same row (5 + 4 = 9 of 10),
    // and the status-demote statement of the pre-release flow never ran.
    const totalsRun = state.runs.find(
      (r) => r.sql === "UPDATE submissions SET final_score = ?, total_possible = ? WHERE id = ?",
    );
    expect(totalsRun?.params).toEqual([9, 10, "sub-rel"]);
    expect(state.runs.some((r) => r.sql.startsWith("UPDATE submissions SET status = ?"))).toBe(
      false,
    );
  });

  it("re-grading a released submission still enforces the question's marks", async () => {
    const db = fakeDb(releasedState());
    await expect(reviewAnswer(db, "teacher-1", "a4", 99, "", "approve")).rejects.toThrow(
      "SCORE_OUT_OF_RANGE",
    );
  });

  it("a non-owner teacher cannot re-grade a released submission", async () => {
    const db = fakeDb(releasedState());
    await expect(reviewAnswer(db, "teacher-2", "a4", 4, "", "approve")).rejects.toThrow(
      "NOT_FOUND",
    );
    await expect(releaseSubmission(db, "teacher-2", "sub-rel", "")).rejects.toThrow("NOT_FOUND");
  });

  it("re-release recomputes canonical totals and republishes the same row", async () => {
    const state = releasedState();
    const db = fakeDb(state);
    await reviewAnswer(db, "teacher-1", "a4", 4, "corrected", "approve");
    const result = await releaseSubmission(db, "teacher-1", "sub-rel", "updated feedback");
    expect(result.finalScore).toBe(9);
    expect(result.totalPossible).toBe(10);
    expect(result.assessmentId).toBe("ex1");
    expect(state.submissions["sub-rel"]?.status).toBe("released");
    expect(state.runs.some((r) => r.sql.startsWith("INSERT INTO audit_log"))).toBe(true);
  });

  it("re-release is still gated: a cleared teacher score blocks it", async () => {
    const state = releasedState();
    state.answers.find((a) => a.id === "a4")!.final_score = null;
    const db = fakeDb(state);
    await expect(releaseSubmission(db, "teacher-1", "sub-rel", "")).rejects.toThrow(
      "NOT_FULLY_GRADED",
    );
  });
});

describe("d1-grading: objective auto-grade", () => {
  it("mcq/true_false need an exact trimmed match; short answers accept alternatives; written is null", () => {
    expect(
      autoScoreFor(
        { type: "mcq", marks: 5 },
        { correct_answer: "4", accepted_alternatives: [], rubric: "", explanation: "" },
        "4",
      ),
    ).toBe(5);
    expect(
      autoScoreFor(
        { type: "mcq", marks: 5 },
        { correct_answer: "4", accepted_alternatives: [], rubric: "", explanation: "" },
        " 4 ",
      ),
    ).toBe(5);
    expect(
      autoScoreFor(
        { type: "mcq", marks: 5 },
        { correct_answer: "4", accepted_alternatives: [], rubric: "", explanation: "" },
        "3",
      ),
    ).toBe(0);
    expect(
      autoScoreFor(
        { type: "true_false", marks: 2 },
        { correct_answer: "true", accepted_alternatives: [], rubric: "", explanation: "" },
        "true",
      ),
    ).toBe(2);
    expect(
      autoScoreFor(
        { type: "short_answer", marks: 4 },
        {
          correct_answer: "Paris",
          accepted_alternatives: ["paris city"],
          rubric: "",
          explanation: "",
        },
        "  PARIS   city ",
      ),
    ).toBe(4);
    expect(
      autoScoreFor(
        { type: "short_answer", marks: 4 },
        { correct_answer: "Paris", accepted_alternatives: [], rubric: "", explanation: "" },
        "London",
      ),
    ).toBe(0);
    expect(
      autoScoreFor(
        { type: "written", marks: 10 },
        { correct_answer: "", accepted_alternatives: [], rubric: "r", explanation: "" },
        "anything",
      ),
    ).toBeNull();
    expect(autoScoreFor({ type: "mcq", marks: 5 }, null, "4")).toBeNull();
  });
});

describe("d1-grading: objective auto-apply (setAutoScores)", () => {
  it("promotes the auto-grade to final for ungraded objective answers and approves a fully-scored submission", async () => {
    const state = baseState();
    // q1 answered "4" (correct, key "4"), q2 answered "x" (wrong).
    const db = fakeDb(state);
    await setAutoScores(db, "teacher-1", "sub-1", [
      { answerId: "a1", score: 5 },
      { answerId: "a2", score: 0 },
    ]);
    const a1 = state.answers.find((a) => a.id === "a1")!;
    const a2 = state.answers.find((a) => a.id === "a2")!;
    expect(a1.final_score).toBe(5);
    expect(a1.auto_score).toBe(5);
    expect(a1.review_status).toBe("auto_graded");
    expect(a2.final_score).toBe(0);
    expect(a2.auto_score).toBe(0);
    expect(a2.review_status).toBe("auto_graded");
    expect(state.submissions["sub-1"]!.status).toBe("approved");
  });

  it("never overwrites a teacher score and stays awaiting_review while other answers pend", async () => {
    const state = baseState();
    // a1 already carries a teacher score; a3 (q3, written) is still ungraded.
    state.questions["ex1"] = [
      { id: "q1", marks: 5 },
      { id: "q2", marks: 5 },
      { id: "q3", marks: 10 },
    ];
    state.answers.find((a) => a.id === "a1")!.final_score = 3;
    state.answers.find((a) => a.id === "a1")!.review_status = "approved";
    state.answers.push({
      id: "a3",
      submission_id: "sub-1",
      question_id: "q3",
      response: "essay",
      max_marks: 10,
      auto_score: null,
      final_score: null,
      feedback: "",
      review_status: "not_graded",
    });
    const db = fakeDb(state);
    await setAutoScores(db, "teacher-1", "sub-1", [
      { answerId: "a1", score: 5 },
      { answerId: "a2", score: 0 },
    ]);
    const a1 = state.answers.find((a) => a.id === "a1")!;
    const a2 = state.answers.find((a) => a.id === "a2")!;
    // Teacher score wins: final and status untouched, only auto_score syncs.
    expect(a1.final_score).toBe(3);
    expect(a1.review_status).toBe("approved");
    expect(a1.auto_score).toBe(5);
    // Ungraded objective answer still promotes.
    expect(a2.final_score).toBe(0);
    expect(a2.review_status).toBe("auto_graded");
    // The written answer keeps the submission open for the teacher.
    expect(state.submissions["sub-1"]!.status).toBe("awaiting_review");
  });

  it("is a no-op for a released submission and for a non-owner teacher", async () => {
    const state = baseState();
    state.submissions["sub-1"]!.status = "released";
    const db = fakeDb(state);
    await setAutoScores(db, "teacher-1", "sub-1", [{ answerId: "a2", score: 0 }]);
    expect(state.answers.find((a) => a.id === "a2")!.final_score).toBeNull();
    expect(state.submissions["sub-1"]!.status).toBe("released");
    await expect(
      setAutoScores(db, "teacher-2", "sub-1", [{ answerId: "a2", score: 0 }]),
    ).rejects.toThrow("NOT_FOUND");
  });

  it("autoScoreFor returns null without a teacher key and zero for a keyed question left unanswered", () => {
    expect(
      autoScoreFor(
        { type: "mcq", marks: 5 },
        { correct_answer: "", accepted_alternatives: [], rubric: "", explanation: "" },
        "4",
      ),
    ).toBeNull();
    expect(
      autoScoreFor(
        { type: "mcq", marks: 5 },
        { correct_answer: "4", accepted_alternatives: [], rubric: "", explanation: "" },
        "",
      ),
    ).toBe(0);
    expect(
      autoScoreFor(
        { type: "short_answer", marks: 4 },
        { correct_answer: "", accepted_alternatives: [], rubric: "", explanation: "" },
        "anything",
      ),
    ).toBeNull();
    expect(
      autoScoreFor(
        { type: "short_answer", marks: 4 },
        { correct_answer: "", accepted_alternatives: ["paris"], rubric: "", explanation: "" },
        " Paris ",
      ),
    ).toBe(4);
  });
});
