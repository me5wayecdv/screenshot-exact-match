/**
 * Tests for autoReleaseObjectiveOnSubmit (src/server/d1-take.ts): the
 * submit-time instant release — fully objective exams in full, mixed
 * exams as the objective part only. Uses a
 * dispatch fake for D1Database (same pattern as
 * src/test/d1-grading.test.ts): in-memory rows, mutations applied by
 * SQL shape, so the tests prove the release rule, the totals, the
 * missing-answer zero rows, and the mixed-exam fallback without a
 * Worker binding or a live D1.
 */
import { describe, expect, it } from "vitest";
import { autoReleaseObjectiveOnSubmit } from "@/server/d1-take";
import { isAutoGradable } from "@/lib/auto-grade";
import type { D1Database } from "@/server/d1-auth-store";

type QuestionRow = {
  id: string;
  assessment_id: string;
  type: string;
  marks: number;
  correct_answer: string | null;
  accepted_alternatives: string | null;
};

type AnswerRow = {
  id: string;
  submission_id: string;
  question_id: string;
  response: string;
  max_marks: number;
  auto_score: number | null;
  final_score: number | null;
  review_status: string;
};

type SubmissionRowState = {
  id: string;
  assessment_id: string;
  student_id: string;
  status: string;
  final_score: number | null;
  total_possible: number;
  released_at: string | null;
};

type State = {
  submissions: Record<string, SubmissionRowState>;
  questions: QuestionRow[];
  answers: AnswerRow[];
  audit: { actor: string; action: string; entity: string; details: Record<string, unknown> }[];
};

function fakeDb(state: State): D1Database {
  const makeStmt = (sql: string, params: unknown[]) => ({
    first: async <T>(): Promise<T | null> => {
      if (sql.startsWith("SELECT * FROM submissions")) {
        const sub = state.submissions[params[0] as string];
        return (sub ? { ...sub } : null) as T | null;
      }
      if (sql.startsWith("SELECT title FROM assessments")) return { title: "امتحان تجريبي" } as T;
      return null;
    },
    all: async <T>(): Promise<{ results?: T[] }> => {
      if (sql.includes("FROM questions q LEFT JOIN question_keys")) {
        return {
          results: state.questions.filter((q) => q.assessment_id === params[0]) as unknown as T[],
        };
      }
      if (sql.startsWith("SELECT id, question_id, response, final_score FROM answers")) {
        return {
          results: state.answers.filter((a) => a.submission_id === params[0]) as unknown as T[],
        };
      }
      return { results: [] };
    },
    run: async () => {
      if (sql.startsWith("UPDATE answers SET auto_score")) {
        const a = state.answers.find((x) => x.id === params[2] && x.submission_id === params[3]);
        if (a) {
          a.auto_score = params[0] as number;
          a.final_score = params[1] as number;
          a.review_status = "auto_graded";
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
          review_status: "auto_graded",
        });
      } else if (sql.startsWith("UPDATE submissions SET status = ?")) {
        const sub = state.submissions[params[4] as string];
        if (sub) {
          sub.status = params[0] as string;
          sub.final_score = params[1] as number;
          sub.total_possible = params[2] as number;
          sub.released_at = params[3] as string;
        }
      } else if (sql.startsWith("INSERT INTO audit_log")) {
        state.audit.push({
          actor: params[0] as string,
          action: params[1] as string,
          entity: params[2] as string,
          details: JSON.parse(params[3] as string) as Record<string, unknown>,
        });
      }
    },
  });
  return {
    prepare: (sql: string) => ({ bind: (...params: unknown[]) => makeStmt(sql, params) }),
    batch: async (stmts: { run: () => Promise<void> }[]) => {
      for (const st of stmts) await st.run();
      return [];
    },
  } as unknown as D1Database;
}

function baseState(): State {
  return {
    submissions: {
      "sub-1": {
        id: "sub-1",
        assessment_id: "ex1",
        student_id: "student-a",
        status: "awaiting_review",
        final_score: null,
        total_possible: 0,
        released_at: null,
      },
    },
    questions: [
      {
        id: "q1",
        assessment_id: "ex1",
        type: "mcq",
        marks: 5,
        correct_answer: "4",
        accepted_alternatives: "[]",
      },
      {
        id: "q2",
        assessment_id: "ex1",
        type: "true_false",
        marks: 5,
        correct_answer: "true",
        accepted_alternatives: "[]",
      },
      {
        id: "q3",
        assessment_id: "ex1",
        type: "short_answer",
        marks: 5,
        correct_answer: "القاهرة",
        accepted_alternatives: '["قاهرة"]',
      },
    ],
    answers: [
      {
        id: "a1",
        submission_id: "sub-1",
        question_id: "q1",
        response: "4",
        max_marks: 5,
        auto_score: null,
        final_score: null,
        review_status: "not_graded",
      },
      {
        id: "a2",
        submission_id: "sub-1",
        question_id: "q2",
        response: "false",
        max_marks: 5,
        auto_score: null,
        final_score: null,
        review_status: "not_graded",
      },
      {
        id: "a3",
        submission_id: "sub-1",
        question_id: "q3",
        response: " قاهرة ",
        max_marks: 5,
        auto_score: null,
        final_score: null,
        review_status: "not_graded",
      },
    ],
    audit: [],
  };
}

describe("d1-take: auto-release of fully objective exams", () => {
  it("releases instantly with canonical totals: match = full marks, mismatch = zero, keyed short answer accepts alternatives", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const released = await autoReleaseObjectiveOnSubmit(db, "sub-1", "2026-11-20T16:00:00.000Z");
    expect(released).toBe("released");
    const [a1, a2, a3] = state.answers;
    expect(a1!.final_score).toBe(5); // mcq exact match
    expect(a2!.final_score).toBe(0); // true_false mismatch
    expect(a3!.final_score).toBe(5); // short_answer via accepted alternative
    for (const a of state.answers) {
      expect(a.review_status).toBe("auto_graded");
      expect(a.auto_score).toBe(a.final_score);
    }
    const sub = state.submissions["sub-1"]!;
    expect(sub.status).toBe("released");
    expect(sub.final_score).toBe(10);
    expect(sub.total_possible).toBe(15);
    expect(sub.released_at).toBe("2026-11-20T16:00:00.000Z");
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]!.action).toBe("auto_release");
    expect(state.audit[0]!.actor).toBe("student-a");
  });

  it("counts a question with no answer row as an unanswered zero and still releases", async () => {
    const state = baseState();
    state.answers = state.answers.filter((a) => a.question_id !== "q3");
    const db = fakeDb(state);
    const released = await autoReleaseObjectiveOnSubmit(db, "sub-1");
    expect(released).toBe("released");
    const inserted = state.answers.find((a) => a.question_id === "q3")!;
    expect(inserted.response).toBe("");
    expect(inserted.final_score).toBe(0);
    expect(inserted.review_status).toBe("auto_graded");
    expect(state.submissions["sub-1"]!.status).toBe("released");
    expect(state.submissions["sub-1"]!.final_score).toBe(5);
    expect(state.submissions["sub-1"]!.total_possible).toBe(15);
  });

  it("partially releases a mixed exam: objective scores publish instantly, the essay waits for the teacher", async () => {
    const state = baseState();
    state.questions.push({
      id: "q4",
      assessment_id: "ex1",
      type: "written",
      marks: 10,
      correct_answer: null,
      accepted_alternatives: null,
    });
    state.answers.push({
      id: "a4",
      submission_id: "sub-1",
      question_id: "q4",
      response: "إجابة مقالية",
      max_marks: 10,
      auto_score: null,
      final_score: null,
      review_status: "not_graded",
    });
    const db = fakeDb(state);
    const released = await autoReleaseObjectiveOnSubmit(db, "sub-1", "2026-11-20T16:00:00.000Z");
    expect(released).toBe("partial");
    const [a1, a2, a3, a4] = state.answers;
    expect(a1!.final_score).toBe(5);
    expect(a2!.final_score).toBe(0);
    expect(a3!.final_score).toBe(5);
    // The essay answer is untouched: no score, still the teacher's.
    expect(a4!.final_score).toBeNull();
    expect(a4!.review_status).toBe("not_graded");
    const sub = state.submissions["sub-1"]!;
    expect(sub.status).toBe("awaiting_review");
    // Published totals are the objective part only: 10 of 15, not of 25.
    expect(sub.final_score).toBe(10);
    expect(sub.total_possible).toBe(15);
    expect(sub.released_at).toBe("2026-11-20T16:00:00.000Z");
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]!.action).toBe("auto_release_partial");
    expect(state.audit[0]!.details["pending_questions"]).toBe(1);
  });

  it("partially releases when an unkeyed objective question joins the keyed ones", async () => {
    const state = baseState();
    state.questions[0]!.correct_answer = null; // no question_keys row for q1
    state.questions[0]!.accepted_alternatives = null;
    const db = fakeDb(state);
    expect(await autoReleaseObjectiveOnSubmit(db, "sub-1")).toBe("partial");
    // q1 stays ungraded for the teacher; q2 + q3 publish.
    expect(state.answers[0]!.final_score).toBeNull();
    expect(state.answers[1]!.final_score).toBe(0);
    expect(state.answers[2]!.final_score).toBe(5);
    const sub = state.submissions["sub-1"]!;
    expect(sub.status).toBe("awaiting_review");
    expect(sub.final_score).toBe(5);
    expect(sub.total_possible).toBe(10);
  });

  it("keeps an essay-only exam awaiting_review, untouched", async () => {
    const state = baseState();
    state.questions = [
      {
        id: "q9",
        assessment_id: "ex1",
        type: "written",
        marks: 20,
        correct_answer: null,
        accepted_alternatives: null,
      },
    ];
    state.answers = [];
    const db = fakeDb(state);
    expect(await autoReleaseObjectiveOnSubmit(db, "sub-1")).toBeNull();
    expect(state.submissions["sub-1"]!.status).toBe("awaiting_review");
    expect(state.submissions["sub-1"]!.final_score).toBeNull();
    expect(state.audit).toHaveLength(0);
  });

  it("is a no-op when the submission is not awaiting_review", async () => {
    const state = baseState();
    state.submissions["sub-1"]!.status = "released";
    const db = fakeDb(state);
    expect(await autoReleaseObjectiveOnSubmit(db, "sub-1")).toBeNull();
    expect(state.answers.every((a) => a.final_score === null)).toBe(true);
    expect(state.audit).toHaveLength(0);
  });
});

describe("auto-grade: isAutoGradable", () => {
  it("objective types need a usable key; written is never auto-gradable", () => {
    const key = (correct: string, alts: string[] = []) => ({
      correct_answer: correct,
      accepted_alternatives: alts,
      rubric: "",
      explanation: "",
    });
    expect(isAutoGradable({ type: "mcq" }, key("4"))).toBe(true);
    expect(isAutoGradable({ type: "mcq" }, key(""))).toBe(false);
    expect(isAutoGradable({ type: "mcq" }, null)).toBe(false);
    expect(isAutoGradable({ type: "true_false" }, key("true"))).toBe(true);
    expect(isAutoGradable({ type: "short_answer" }, key("باريس"))).toBe(true);
    expect(isAutoGradable({ type: "short_answer" }, key("", ["paris"]))).toBe(true);
    expect(isAutoGradable({ type: "short_answer" }, key(""))).toBe(false);
    expect(isAutoGradable({ type: "written" }, key("anything"))).toBe(false);
  });
});
