/**
 * Regression tests for BIZ-F7 (deep audit 2026-11-12): the DO flush
 * applied draft answers to D1 with no D1-status guard, so a late
 * flush could rewrite response text underneath already-set grades
 * or after release, while the grades and totals stayed — the
 * released record no longer matched what the student wrote.
 *
 * Scenario: a dirty DO row (a draft the student made in the DO)
 * flushes AFTER the D1 submission was submitted, graded and
 * released through the D1 path. The flush must NOT overwrite the
 * graded answers or scores; the D1 record is authoritative once
 * grading starts. The DO row is marked clean (its stale draft is
 * discarded, not retried forever).
 *
 * Compact dispatch fake for D1Database, same pattern as
 * src/test/take-session-logic.test.ts, but only the SQL the flush
 * path uses. No Worker binding, no live D1.
 */
import { describe, expect, it } from "vitest";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";
import {
  applyDraft,
  applyStart,
  flushOne,
  type DoAnswerState,
  type DoSubmissionState,
  type SessionStore,
} from "@/server/take-session-logic";

const NOW = "2026-11-10T17:00:00.000Z";
const STUDENT = "student-1";
const EXAM = "exam-1";
const Q1 = "q-1";
const Q2 = "q-2";
const MARKS = { [Q1]: 5, [Q2]: 10 };

/* ------------------------------------------------ Map-backed store */

class MapStore implements SessionStore {
  subs = new Map<string, DoSubmissionState>();
  answers = new Map<string, Map<string, DoAnswerState>>();

  async getSubmission(id: string) {
    return this.subs.get(id) ?? null;
  }
  async putSubmission(sub: DoSubmissionState) {
    this.subs.set(sub.id, { ...sub });
  }
  async getAnswers(submissionId: string) {
    return [...(this.answers.get(submissionId)?.values() ?? [])];
  }
  async upsertAnswers(submissionId: string, answers: DoAnswerState[]) {
    let byQ = this.answers.get(submissionId);
    if (!byQ) {
      byQ = new Map();
      this.answers.set(submissionId, byQ);
    }
    for (const a of answers) byQ.set(a.questionId, { ...a });
  }
  async listDirty(limit: number) {
    return [...this.subs.values()]
      .filter((s) => s.dirty)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }
  async markClean(id: string) {
    const sub = this.subs.get(id);
    if (sub) this.subs.set(id, { ...sub, dirty: false });
  }
  async bumpFlushAttempt(id: string, error: string) {
    const sub = this.subs.get(id);
    if (!sub) return 0;
    const next = sub.flushAttempts + 1;
    this.subs.set(id, { ...sub, flushAttempts: next, flushError: error });
    return next;
  }
  async transaction<T>(fn: () => Promise<T>) {
    return fn();
  }
  async getInProgressSubmission(studentId: string, assessmentId: string) {
    const found = [...this.subs.values()]
      .filter(
        (s) =>
          s.studentId === studentId &&
          s.assessmentId === assessmentId &&
          s.status === "in_progress",
      )
      .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
    return found ? { ...found } : null;
  }
  async countSubmissions(studentId: string, assessmentId: string) {
    return [...this.subs.values()].filter(
      (s) => s.studentId === studentId && s.assessmentId === assessmentId,
    ).length;
  }
  async listStudentSubmissions(studentId: string, assessmentId: string) {
    return [...this.subs.values()]
      .filter((s) => s.studentId === studentId && s.assessmentId === assessmentId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber)
      .map((s) => ({ ...s }));
  }
  hydrated = new Set<string>();
  async areAnswersHydrated(submissionId: string) {
    return this.hydrated.has(submissionId);
  }
  async setAnswersHydrated(submissionId: string) {
    this.hydrated.add(submissionId);
  }
}

/* --------------------------------------- compact D1 dispatch fake */

type FakeAnswer = {
  id: string;
  response: string;
  max_marks: number;
  final_score: number | null;
};

type FakeState = {
  questions: Record<string, { id: string; marks: number }[]>;
  submissions: Record<string, Record<string, unknown>>;
  answers: Record<string, FakeAnswer>;
};

function makeFakeDb(state: FakeState): D1Database {
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const exec = (sql: string, params: unknown[]): unknown => {
    const s = norm(sql);
    if (s.startsWith("INSERT INTO submissions")) {
      const id = params[0] as string;
      if (state.submissions[id]) throw new Error("UNIQUE constraint failed: submissions.id");
      state.submissions[id] = {
        id,
        assessment_id: params[1],
        student_id: params[2],
        status: "in_progress",
        attempt_number: params[3],
        started_at: params[4],
        submitted_at: params[5],
        expires_at: params[6],
        question_order: params[7],
        total_possible: params[8],
        final_score: null,
        draft_seq: 0,
      };
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO answers")) {
      const [id, submissionId, questionId, response, maxMarks] = params as [
        string,
        string,
        string,
        string,
        number,
      ];
      state.answers[`${submissionId}:${questionId}`] = {
        id,
        response,
        max_marks: maxMarks,
        final_score: null,
      };
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE answers SET response")) {
      const [response, , answerId] = params as [string, number, string];
      for (const key of Object.keys(state.answers)) {
        const answer = state.answers[key];
        if (answer?.id === answerId) answer.response = response;
      }
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE submissions SET draft_seq")) {
      const [seq, id] = params as [number, string];
      const row = state.submissions[id];
      if (row) row["draft_seq"] = seq;
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE submissions SET status")) {
      const [submittedAt, id] = params as [string, string];
      const row = state.submissions[id];
      if (row) {
        row["status"] = "awaiting_review";
        row["submitted_at"] = submittedAt;
      }
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  };
  const query = (sql: string, params: unknown[]): unknown => {
    const s = norm(sql);
    if (s.startsWith("SELECT id FROM submissions WHERE id = ?")) {
      const row = state.submissions[params[0] as string];
      return row ? { id: row["id"] } : null;
    }
    if (s.startsWith("SELECT * FROM submissions WHERE id = ?")) {
      return state.submissions[params[0] as string] ?? null;
    }
    if (s.startsWith("SELECT q.id AS question_id")) {
      // questions q LEFT JOIN answers a — params: submissionId,
      // assessmentId, ...questionIds.
      const submissionId = params[0] as string;
      const questionIds = params.slice(2) as string[];
      const all = state.questions[EXAM] ?? [];
      return all
        .filter((q) => questionIds.includes(q.id))
        .map((q) => ({
          question_id: q.id,
          marks: q.marks,
          answer_id: state.answers[`${submissionId}:${q.id}`]?.id ?? null,
        }));
    }
    return null;
  };
  const statement = (sql: string): D1Statement => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        bound = p;
        return stmt as unknown as D1Statement;
      },
      async run() {
        return exec(sql, bound);
      },
      async first<T>() {
        return query(sql, bound) as T | null;
      },
      async all<T>() {
        const result = query(sql, bound);
        return { results: Array.isArray(result) ? (result as T[]) : [] };
      },
    };
    return stmt as unknown as D1Statement;
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: D1Statement[]) => {
      const out: unknown[] = [];
      for (const stmt of stmts) out.push(await stmt.run());
      return out;
    },
  } as unknown as D1Database;
}

function fakeState(): FakeState {
  return {
    questions: {
      [EXAM]: [
        { id: Q1, marks: 5 },
        { id: Q2, marks: 10 },
      ],
    },
    submissions: {},
    answers: {},
  };
}

/* ------------------------------------------------------- scenario */

/** Start + draft "draft-A" in the DO, flush it to D1, then draft
 *  "draft-B" in the DO (dirty, unflushed). Returns the store, db
 *  and state so the test can grade/release the D1 row in between. */
async function dirtyDraftAfterFirstFlush() {
  const state = fakeState();
  const db = makeFakeDb(state);
  const store = new MapStore();
  await applyStart(store, {
    submissionId: "sub-1",
    studentId: STUDENT,
    assessmentId: EXAM,
    questionOrder: [Q1, Q2],
    attemptNumber: 1,
    totalPossible: 15,
    expiresAt: null,
    nowIso: NOW,
  });
  await applyDraft(store, {
    submissionId: "sub-1",
    studentId: STUDENT,
    answers: [{ question_id: Q1, response: "draft-A", time_spent_seconds: 3 }],
    seq: 1,
    marks: MARKS,
    nowIso: NOW,
  });
  const first = (await store.getSubmission("sub-1")) as DoSubmissionState;
  expect(await flushOne(db, store, first)).toEqual({ ok: true });
  expect(state.answers["sub-1:q-1"]).toMatchObject({ response: "draft-A" });

  // A newer draft lands in the DO but has not flushed yet.
  await applyDraft(store, {
    submissionId: "sub-1",
    studentId: STUDENT,
    answers: [{ question_id: Q1, response: "draft-B", time_spent_seconds: 5 }],
    seq: 2,
    marks: MARKS,
    nowIso: NOW,
  });
  expect((await store.getSubmission("sub-1"))?.dirty).toBe(true);
  return { state, db, store };
}

/** What the D1 grading/release path does to the row (mirrors
 *  reviewAnswer + release in d1-grading.ts): per-answer final
 *  scores, submission status + total. The submitted response text
 *  itself is untouched by grading. */
function gradeAndRelease(state: FakeState, status: "approved" | "released") {
  const row = state.submissions["sub-1"]!;
  row["status"] = status;
  row["final_score"] = 5;
  state.answers["sub-1:q-1"]!.final_score = 5;
}

describe("flush after grading (BIZ-F7)", () => {
  it("does not overwrite answers or scores once the D1 row is released", async () => {
    const { state, db, store } = await dirtyDraftAfterFirstFlush();
    gradeAndRelease(state, "released");

    const sub = (await store.getSubmission("sub-1")) as DoSubmissionState;
    expect(await flushOne(db, store, sub)).toEqual({ ok: true });

    // The graded record is untouched: submitted text, per-answer
    // score and submission total all still match the grading.
    expect(state.submissions["sub-1"]).toMatchObject({
      status: "released",
      final_score: 5,
    });
    expect(state.answers["sub-1:q-1"]).toMatchObject({
      response: "draft-A",
      final_score: 5,
    });
    // The stale DO draft is discarded, not left dirty to retry.
    expect((await store.getSubmission("sub-1"))?.dirty).toBe(false);
  });

  it("does not overwrite answers or scores once the D1 row is approved (graded, unreleased)", async () => {
    const { state, db, store } = await dirtyDraftAfterFirstFlush();
    gradeAndRelease(state, "approved");

    const sub = (await store.getSubmission("sub-1")) as DoSubmissionState;
    expect(await flushOne(db, store, sub)).toEqual({ ok: true });

    expect(state.submissions["sub-1"]).toMatchObject({
      status: "approved",
      final_score: 5,
    });
    expect(state.answers["sub-1:q-1"]).toMatchObject({
      response: "draft-A",
      final_score: 5,
    });
    expect((await store.getSubmission("sub-1"))?.dirty).toBe(false);
  });

  it("still flushes normally while the D1 row is in_progress (control)", async () => {
    const { state, db, store } = await dirtyDraftAfterFirstFlush();
    const sub = (await store.getSubmission("sub-1")) as DoSubmissionState;
    expect(await flushOne(db, store, sub)).toEqual({ ok: true });
    expect(state.answers["sub-1:q-1"]).toMatchObject({ response: "draft-B" });
    expect(state.submissions["sub-1"]).toMatchObject({
      status: "in_progress",
      draft_seq: 2,
    });
    expect((await store.getSubmission("sub-1"))?.dirty).toBe(false);
  });
});
