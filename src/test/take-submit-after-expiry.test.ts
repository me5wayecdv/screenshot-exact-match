/**
 * Regression tests for BIZ-F2 (deep audit 2026-11-12): the DO rejected
 * submit after expiry, contradicting the D1 rule in
 * src/server/d1-take.ts (submitAttemptOnce: "Submit stays allowed
 * after expiry/window end: edits are already frozen by saveDraft,
 * and rejecting here would destroy frozen work"). The countdown
 * auto-submit fires at remaining===0 — the same moment the DO
 * started rejecting — so an expired timer stranded the attempt in
 * `in_progress` forever with no recovery path.
 *
 * Rule under test: edits freeze at expiry/window end (applyDraft
 * still returns not_editable), but submit stays allowed and moves
 * the submission to awaiting_review like any other submit.
 *
 * Map-backed SessionStore, same pattern as
 * src/test/take-session-logic.test.ts. No Worker binding, no live D1.
 */
import { describe, expect, it } from "vitest";
import {
  applyDraft,
  applyStart,
  applySubmit,
  getSessionStatus,
  type DoAnswerState,
  type DoSubmissionState,
  type SessionStore,
} from "@/server/take-session-logic";

const NOW = "2026-11-10T17:00:00.000Z";
const LATE = "2026-11-10T17:05:00.000Z";
const STUDENT = "student-1";
const EXAM = "exam-1";
const Q1 = "q-1";
const Q2 = "q-2";
const MARKS = { [Q1]: 5, [Q2]: 10 };

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

async function startedStore(expiresAt: string | null = null) {
  const store = new MapStore();
  await applyStart(store, {
    submissionId: "sub-1",
    studentId: STUDENT,
    assessmentId: EXAM,
    questionOrder: [Q1, Q2],
    attemptNumber: 1,
    totalPossible: 15,
    expiresAt,
    nowIso: NOW,
  });
  return store;
}

function submitInput(nowIso: string, dueAt?: string) {
  return {
    submissionId: "sub-1",
    studentId: STUDENT,
    answers: [
      { question_id: Q1, response: "final-1", time_spent_seconds: 2 },
      { question_id: Q2, response: "final-2", time_spent_seconds: 4 },
    ],
    seq: 2,
    marks: MARKS,
    nowIso,
    ...(dueAt ? { dueAt } : {}),
  };
}

describe("BIZ-F2: submit after expiry (D1 rule mirrored in the DO)", () => {
  it("submit after expiresAt succeeds and reaches awaiting_review", async () => {
    const store = await startedStore("2026-11-10T16:00:00.000Z");
    // Draft while still in time, so there is frozen work to save.
    await applyDraft(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "draft", time_spent_seconds: 1 }],
      seq: 1,
      marks: MARKS,
      nowIso: NOW,
    });
    const result = await applySubmit(store, submitInput(LATE));
    expect(result).toEqual({ submitted: true });
    const sub = await store.getSubmission("sub-1");
    expect(sub?.status).toBe("awaiting_review");
    expect(sub?.submittedAt).toBe(LATE);
    expect(sub?.dirty).toBe(true);
    expect((await store.getAnswers("sub-1")).map((a) => a.response).sort()).toEqual([
      "final-1",
      "final-2",
    ]);
  });

  it("submit after the window end (dueAt) succeeds and reaches awaiting_review", async () => {
    const store = await startedStore();
    const result = await applySubmit(store, submitInput(LATE, "2026-11-10T16:00:00.000Z"));
    expect(result).toEqual({ submitted: true });
    expect((await store.getSubmission("sub-1"))?.status).toBe("awaiting_review");
  });

  it("the countdown auto-submit at expiry no longer strands the attempt", async () => {
    // Timer hits zero at expiresAt; the client auto-submit fires at
    // remaining===0, i.e. nowIso just past expiresAt (slow network /
    // throttled tab / clock skew). The attempt must land submitted,
    // and a manual re-submit afterwards must ack as already submitted
    // instead of erroring — the student can see the submitted state.
    const store = await startedStore("2026-11-10T17:00:00.000Z");
    const auto = await applySubmit(store, submitInput("2026-11-10T17:00:01.000Z"));
    expect(auto).toEqual({ submitted: true });
    expect(
      await getSessionStatus(store, {
        submissionId: "sub-1",
        studentId: STUDENT,
        assessmentId: EXAM,
      }),
    ).toEqual({ status: "submitted", submissionId: "sub-1", lastAppliedDraftSeq: 2 });
    const retry = await applySubmit(store, submitInput("2026-11-10T17:00:02.000Z"));
    expect(retry).toEqual({ submitted: false });
    expect((await store.getSubmission("sub-1"))?.status).toBe("awaiting_review");
  });

  it("edits still freeze at expiry even though submit is allowed", async () => {
    const store = await startedStore("2026-11-10T16:00:00.000Z");
    const draft = await applyDraft(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "too late", time_spent_seconds: 1 }],
      seq: 1,
      marks: MARKS,
      nowIso: LATE,
    });
    expect(draft).toEqual({ applied: "not_editable", lastAppliedDraftSeq: 0 });
    // ...and the frozen work can still be submitted afterwards.
    expect(await applySubmit(store, submitInput(LATE))).toEqual({ submitted: true });
  });
});
