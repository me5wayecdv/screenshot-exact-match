/**
 * Tests for the Phase 4 take-session logic
 * (src/server/take-session-logic.ts): the DO's live session state
 * transitions (start / draft seq guard / submit / status) over a
 * Map-backed SessionStore, and the D1 flush (flushOne / flushDirty)
 * against a compact dispatch fake for D1Database (same pattern as
 * src/test/take-queue.test.ts, but only the SQL the flush path
 * uses). No Worker binding, no live D1.
 *
 * The DO class itself (take-session.ts, the thin runtime wrapper
 * around this logic + the DurableObject global) is NOT tested here
 * — the global does not exist in vitest's node env. It is verified
 * live (smoke + ladder), as the Phase 3 worker-entry wrapper was.
 */
import { describe, expect, it } from "vitest";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";
import {
  applyDraft,
  applyStart,
  applySubmit,
  flushDirty,
  flushOne,
  getCachedMarks,
  getSessionStatus,
  hydrateFromD1,
  validateStart,
  TAKE_SESSION_CACHE_TTL_MS,
  TAKE_SESSION_FLUSH_MAX_ATTEMPTS,
  type DoAnswerState,
  type DoSubmissionState,
  type ExamConfig,
  type ExamConfigStore,
  type SessionStore,
} from "@/server/take-session-logic";

const NOW = "2026-11-10T17:00:00.000Z";
const STUDENT = "student-1";
const OTHER = "student-2";
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
    this.subs.set(id(sub), { ...sub });
    function id(s: DoSubmissionState) {
      return s.id;
    }
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
        (s) => s.studentId === studentId && s.assessmentId === assessmentId && s.status === "in_progress",
      )
      .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
    return found ? { ...found } : null;
  }
  async countSubmissions(studentId: string, assessmentId: string) {
    return [...this.subs.values()].filter(
      (s) => s.studentId === studentId && s.assessmentId === assessmentId,
    ).length;
  }
}

/* --------------------------------------- Map-backed config store (V2) */

class MapConfigStore implements ExamConfigStore {
  config: ExamConfig | null = null;
  marks: Record<string, number> = {};
  enrolled = new Map<string, number>();
  seeded = new Set<string>();

  async getConfig() {
    return this.config;
  }
  async setConfig(
    config: ExamConfig,
    marks: Record<string, number>,
    enrolledStudentIds: string[],
  ) {
    this.config = { ...config };
    this.marks = { ...marks };
    this.enrolled = new Map(enrolledStudentIds.map((id) => [id, config.loadedAt]));
  }
  async getMarks() {
    return { ...this.marks };
  }
  async getEnrolledCheckedAt(studentId: string) {
    return this.enrolled.get(studentId) ?? null;
  }
  async setEnrolled(studentId: string, checkedAt: number) {
    this.enrolled.set(studentId, checkedAt);
  }
  async isStudentSeeded(studentId: string) {
    return this.seeded.has(studentId);
  }
  async setStudentSeeded(studentId: string) {
    this.seeded.add(studentId);
  }
}

function startInput(submissionId = "sub-1") {
  return {
    submissionId,
    studentId: STUDENT,
    assessmentId: EXAM,
    questionOrder: [Q1, Q2],
    attemptNumber: 1,
    totalPossible: 15,
    expiresAt: null,
    nowIso: NOW,
  };
}

async function startedStore(submissionId = "sub-1") {
  const store = new MapStore();
  await applyStart(store, startInput(submissionId));
  return store;
}

/* --------------------------------------- compact D1 dispatch fake */

type FakeState = {
  questions: Record<string, { id: string; marks: number }[]>;
  submissions: Record<string, Record<string, unknown>>;
  answers: Record<string, { id: string; response: string; max_marks: number }>;
  audit: { action: string; entity_id: string }[];
  failures: { submission_id: string | null; reason: string; attempts: number }[];
  failSql: { fragment: string; error: Error } | null;
  /** V2: the exam config tables the cache loader + gate read. */
  assessment: {
    status: string;
    starts_at: string | null;
    due_at: string | null;
    max_attempts: number;
    duration_minutes: number | null;
  };
  assignments: string[];
  groupLinks: string[];
  members: { group_id: string; student_id: string; status: string }[];
  /** Counts every first()/all() call — the V2 tests assert the
   *  steady-state start costs zero D1 reads. */
  reads: number;
};

function makeFakeDb(state: FakeState): D1Database {
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const maybeFail = (sql: string) => {
    if (state.failSql && norm(sql).includes(state.failSql.fragment)) throw state.failSql.error;
  };
  const exec = (sql: string, params: unknown[]): unknown => {
    const s = norm(sql);
    maybeFail(s);
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
    if (s.startsWith("INSERT INTO audit_log")) {
      state.audit.push({ action: params[1] as string, entity_id: params[2] as string });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO take_write_failures")) {
      state.failures.push({
        submission_id: params[2] as string | null,
        reason: params[5] as string,
        attempts: params[6] as number,
      });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  };
  const query = (sql: string, params: unknown[]): unknown => {
    const s = norm(sql);
    maybeFail(s);
    if (s.startsWith("SELECT * FROM submissions WHERE id = ?")) {
      return state.submissions[params[0] as string] ?? null;
    }
    if (s.startsWith("SELECT * FROM submissions WHERE assessment_id = ?")) {
      // Seed: all of one student's submissions for this exam.
      return Object.values(state.submissions).filter(
        (r) => r["assessment_id"] === params[0] && r["student_id"] === params[1],
      );
    }
    if (s.startsWith("SELECT status, starts_at, due_at, max_attempts")) {
      return { ...state.assessment };
    }
    if (s.startsWith("SELECT status, starts_at, due_at FROM assessments")) {
      const a = state.assessment;
      return { status: a.status, starts_at: a.starts_at, due_at: a.due_at };
    }
    if (s.startsWith("SELECT id, marks FROM questions")) {
      return (state.questions[EXAM] ?? []).map((q) => ({ id: q.id, marks: q.marks }));
    }
    if (s.startsWith("SELECT student_id FROM assessment_assignments")) {
      return state.assignments.map((student_id) => ({ student_id }));
    }
    if (s.startsWith("SELECT group_id FROM group_exams")) {
      return state.groupLinks.map((group_id) => ({ group_id }));
    }
    if (s.startsWith("SELECT student_id FROM group_members")) {
      // The loader binds the group ids as the params (IN list).
      const ids = params as string[];
      return state.members
        .filter((m) => ids.includes(m.group_id) && m.status === "approved")
        .map((m) => ({ student_id: m.student_id }));
    }
    if (s.startsWith("SELECT 1 AS one FROM assessment_assignments")) {
      const [assessmentId, studentId] = params as [string, string];
      void assessmentId;
      return state.assignments.includes(studentId) ? { one: 1 } : null;
    }
    if (s.startsWith("SELECT 1 AS one FROM group_members")) {
      const [groupId, studentId] = params as [string, string];
      return state.members.some(
        (m) => m.group_id === groupId && m.student_id === studentId && m.status === "approved",
      )
        ? { one: 1 }
        : null;
    }
    if (s.startsWith("SELECT id FROM submissions WHERE id = ?")) {
      const row = state.submissions[params[0] as string];
      return row ? { id: row["id"] } : null;
    }
    if (s.startsWith("SELECT title FROM assessments")) {
      return { title: "Exam 1" };
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
    if (s.startsWith("SELECT question_id, response")) {
      const submissionId = params[0] as string;
      return Object.entries(state.answers)
        .filter(([key]) => key.startsWith(`${submissionId}:`))
        .map(([key, a]) => ({
          question_id: key.split(":")[1],
          response: a.response,
          max_marks: a.max_marks,
          time_spent_seconds: 0,
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
        state.reads += 1;
        return query(sql, bound) as T | null;
      },
      async all<T>() {
        state.reads += 1;
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
    questions: { [EXAM]: [{ id: Q1, marks: 5 }, { id: Q2, marks: 10 }] },
    submissions: {},
    answers: {},
    audit: [],
    failures: [],
    failSql: null,
    assessment: {
      status: "published",
      starts_at: null,
      due_at: null,
      max_attempts: 10,
      duration_minutes: 60,
    },
    assignments: [STUDENT, OTHER],
    groupLinks: ["g-1"],
    members: [
      { group_id: "g-1", student_id: STUDENT, status: "approved" },
      { group_id: "g-1", student_id: OTHER, status: "approved" },
    ],
    reads: 0,
  };
}

/* ------------------------------------------------------------------ */

describe("applyStart", () => {
  it("creates an in-progress dirty submission", async () => {
    const store = new MapStore();
    const { submissionId } = await applyStart(store, startInput());
    expect(submissionId).toBe("sub-1");
    const sub = await store.getSubmission("sub-1");
    expect(sub?.status).toBe("in_progress");
    expect(sub?.dirty).toBe(true);
    expect(sub?.draftSeq).toBe(0);
    expect(sub?.totalPossible).toBe(15);
  });

  it("is idempotent by submissionId", async () => {
    const store = await startedStore();
    const again = await applyStart(store, startInput());
    expect(again.submissionId).toBe("sub-1");
    expect(store.subs.size).toBe(1);
  });

  it("rejects a submissionId owned by another student", async () => {
    const store = await startedStore();
    await expect(
      applyStart(store, { ...startInput(), studentId: OTHER }),
    ).rejects.toThrow("TAKE_NOT_FOUND");
  });
});

describe("applyDraft seq guard", () => {
  it("applies a newer seq and drops unknown questions", async () => {
    const store = await startedStore();
    const result = await applyDraft(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [
        { question_id: Q1, response: "a", time_spent_seconds: 3 },
        { question_id: "q-nope", response: "x", time_spent_seconds: 0 },
      ],
      seq: 1,
      marks: MARKS,
    });
    expect(result).toEqual({ applied: "applied", lastAppliedDraftSeq: 1 });
    const answers = await store.getAnswers("sub-1");
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ questionId: Q1, response: "a", maxMarks: 5 });
  });

  it("drops an older seq and re-applies the same seq as duplicate", async () => {
    const store = await startedStore();
    await applyDraft(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "a", time_spent_seconds: 0 }],
      seq: 2,
      marks: MARKS,
    });
    const older = await applyDraft(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "stale", time_spent_seconds: 0 }],
      seq: 1,
      marks: MARKS,
    });
    expect(older).toEqual({ applied: "duplicate", lastAppliedDraftSeq: 2 });
    const same = await applyDraft(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "a", time_spent_seconds: 0 }],
      seq: 2,
      marks: MARKS,
    });
    expect(same).toEqual({ applied: "duplicate", lastAppliedDraftSeq: 2 });
    expect((await store.getAnswers("sub-1")).at(0)?.response).toBe("a");
  });

  it("rejects a draft for another student's submission", async () => {
    const store = await startedStore();
    await expect(
      applyDraft(store, {
        submissionId: "sub-1",
        studentId: OTHER,
        answers: [],
        seq: 1,
        marks: MARKS,
      }),
    ).rejects.toThrow("TAKE_NOT_FOUND");
  });
});

describe("applySubmit + late draft", () => {
  it("applies full final answers, flips status, and acks a duplicate", async () => {
    const store = await startedStore();
    await applyDraft(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "draft", time_spent_seconds: 1 }],
      seq: 1,
      marks: MARKS,
    });
    const result = await applySubmit(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [
        { question_id: Q1, response: "final-1", time_spent_seconds: 2 },
        { question_id: Q2, response: "final-2", time_spent_seconds: 4 },
      ],
      seq: 2,
      marks: MARKS,
      nowIso: NOW,
    });
    expect(result).toEqual({ submitted: true });
    const sub = await store.getSubmission("sub-1");
    expect(sub?.status).toBe("awaiting_review");
    expect(sub?.submittedAt).toBe(NOW);
    expect(sub?.draftSeq).toBe(2);
    expect((await store.getAnswers("sub-1")).map((a) => a.response).sort()).toEqual([
      "final-1",
      "final-2",
    ]);
    const dup = await applySubmit(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [],
      seq: 3,
      marks: MARKS,
      nowIso: NOW,
    });
    expect(dup).toEqual({ submitted: false });
  });

  it("drops a late draft after submit as not_editable", async () => {
    const store = await startedStore();
    await applySubmit(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "f", time_spent_seconds: 0 }],
      seq: 1,
      marks: MARKS,
      nowIso: NOW,
    });
    const late = await applyDraft(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "too late", time_spent_seconds: 0 }],
      seq: 2,
      marks: MARKS,
    });
    expect(late.applied).toBe("not_editable");
    expect((await store.getAnswers("sub-1")).at(0)?.response).toBe("f");
  });
});

describe("getSessionStatus", () => {
  it("reports started/submitted, pending for unknown, never leaks", async () => {
    const store = await startedStore();
    expect(
      await getSessionStatus(store, { submissionId: "sub-1", studentId: STUDENT, assessmentId: EXAM }),
    ).toEqual({ status: "started", submissionId: "sub-1", lastAppliedDraftSeq: 0, redirected: false });
    expect(
      await getSessionStatus(store, { submissionId: "sub-1", studentId: OTHER, assessmentId: EXAM }),
    ).toEqual({ status: "pending" });
    expect(
      await getSessionStatus(store, { submissionId: "sub-nope", studentId: STUDENT, assessmentId: EXAM }),
    ).toBeNull();
    await applySubmit(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [],
      seq: 1,
      marks: MARKS,
      nowIso: NOW,
    });
    expect(
      await getSessionStatus(store, { submissionId: "sub-1", studentId: STUDENT, assessmentId: EXAM }),
    ).toEqual({ status: "submitted", submissionId: "sub-1", lastAppliedDraftSeq: 1 });
  });

  it("reports failed after the flush-failure threshold", async () => {
    const store = await startedStore();
    const sub = (await store.getSubmission("sub-1")) as DoSubmissionState;
    await store.putSubmission({
      ...sub,
      flushAttempts: TAKE_SESSION_FLUSH_MAX_ATTEMPTS,
      flushError: "D1 overloaded",
    });
    expect(
      await getSessionStatus(store, { submissionId: "sub-1", studentId: STUDENT, assessmentId: EXAM }),
    ).toEqual({ status: "failed", reason: "D1 overloaded" });
  });
});

describe("hydrateFromD1", () => {
  it("loads a pre-DO D1 row + answers into the store, clean", async () => {
    const state = fakeState();
    state.submissions["sub-1"] = {
      id: "sub-1",
      assessment_id: EXAM,
      student_id: STUDENT,
      status: "in_progress",
      attempt_number: 1,
      started_at: NOW,
      submitted_at: null,
      expires_at: null,
      question_order: JSON.stringify([Q1]),
      total_possible: 15,
      draft_seq: 2,
    };
    state.answers["sub-1:q-1"] = { id: "a-1", response: "old", max_marks: 5 };
    const store = new MapStore();
    const sub = await hydrateFromD1(makeFakeDb(state), store, "sub-1");
    expect(sub?.draftSeq).toBe(2);
    expect(sub?.dirty).toBe(false);
    expect((await store.getAnswers("sub-1")).at(0)?.response).toBe("old");
    expect(await hydrateFromD1(makeFakeDb(state), store, "sub-nope")).toBeNull();
  });
});

describe("flushOne / flushDirty", () => {
  it("flushes a start to D1 (row + draft_seq), then a submit flips + audits once", async () => {
    const state = fakeState();
    const db = makeFakeDb(state);
    const store = await startedStore();
    await applyDraft(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "a", time_spent_seconds: 3 }],
      seq: 1,
      marks: MARKS,
    });
    const sub = (await store.getSubmission("sub-1")) as DoSubmissionState;
    expect(await flushOne(db, store, sub)).toEqual({ ok: true });
    expect(state.submissions["sub-1"]).toMatchObject({ status: "in_progress", draft_seq: 1 });
    expect(state.answers["sub-1:q-1"]).toMatchObject({ response: "a", max_marks: 5 });
    expect((await store.getSubmission("sub-1"))?.dirty).toBe(false);

    await applySubmit(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      answers: [{ question_id: Q2, response: "b", time_spent_seconds: 1 }],
      seq: 2,
      marks: MARKS,
      nowIso: NOW,
    });
    const sub2 = (await store.getSubmission("sub-1")) as DoSubmissionState;
    expect(await flushOne(db, store, sub2)).toEqual({ ok: true });
    expect(state.submissions["sub-1"]).toMatchObject({
      status: "awaiting_review",
      draft_seq: 2,
    });
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({ action: "exam_submitted", entity_id: "sub-1" });

    // A duplicate flush never double-audits.
    const sub3 = (await store.getSubmission("sub-1")) as DoSubmissionState;
    expect(await flushOne(db, store, sub3)).toEqual({ ok: true });
    expect(state.audit).toHaveLength(1);
  });

  it("flushDirty batches dirty rows and reports remaining", async () => {
    const state = fakeState();
    const db = makeFakeDb(state);
    const store = new MapStore();
    await applyStart(store, startInput("sub-1"));
    await applyStart(store, startInput("sub-2"));
    const result = await flushDirty(db, store, 1);
    expect(result).toEqual({ flushed: 1, failed: 0, remaining: true });
    const rest = await flushDirty(db, store, 10);
    expect(rest).toEqual({ flushed: 1, failed: 0, remaining: false });
    expect(Object.keys(state.submissions).sort()).toEqual(["sub-1", "sub-2"]);
  });

  it("records a failure at the threshold and leaves the row dirty", async () => {
    const state = fakeState();
    state.failSql = { fragment: "INSERT INTO submissions", error: new Error("D1_FAKE_WRITE_FAIL") };
    const db = makeFakeDb(state);
    const store = await startedStore();
    const sub = (await store.getSubmission("sub-1")) as DoSubmissionState;
    for (let i = 0; i < TAKE_SESSION_FLUSH_MAX_ATTEMPTS; i += 1) {
      expect(await flushOne(db, store, sub)).toEqual({
        ok: false,
        reason: "D1_FAKE_WRITE_FAIL",
      });
    }
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]).toMatchObject({
      submission_id: "sub-1",
      attempts: TAKE_SESSION_FLUSH_MAX_ATTEMPTS,
    });
    expect((await store.getSubmission("sub-1"))?.dirty).toBe(true);
    const status = await getSessionStatus(store, {
      submissionId: "sub-1",
      studentId: STUDENT,
      assessmentId: EXAM,
    });
    expect(status).toEqual({ status: "failed", reason: "D1_FAKE_WRITE_FAIL" });
  });
});

/* ------------------------------------------------- V2: config cache */

async function doStart(
  store: MapStore,
  cfg: MapConfigStore,
  db: D1Database,
  studentId = STUDENT,
  submissionId = "sub-1",
) {
  const validated = await validateStart(store, cfg, db, {
    studentId,
    assessmentId: EXAM,
    nowIso: NOW,
  });
  if ("existingId" in validated) {
    return { queued: false, submissionId: validated.existingId };
  }
  const result = await applyStart(store, {
    submissionId,
    studentId,
    assessmentId: EXAM,
    questionOrder: [Q1, Q2],
    attemptNumber: validated.attemptNumber,
    totalPossible: validated.totalPossible,
    expiresAt: validated.expiresAt,
    nowIso: NOW,
  });
  return { queued: true, submissionId: result.submissionId };
}

describe("validateStart (V2 cache)", () => {
  it("loads the config once, then steady-state starts cost zero D1 reads", async () => {
    const state = fakeState();
    const db = makeFakeDb(state);
    const store = new MapStore();
    const cfg = new MapConfigStore();

    // First student: config load (5 reads) + seed (1 read) = 6.
    const first = await doStart(store, cfg, db, STUDENT, "sub-1");
    expect(first).toEqual({ queued: true, submissionId: "sub-1" });
    expect(state.reads).toBe(6);
    expect(cfg.config?.totalPossible).toBe(15);

    // Second student, same exam: config + enrollment cached, seed only.
    const readsBefore = state.reads;
    const second = await doStart(store, cfg, db, OTHER, "sub-2");
    expect(second).toEqual({ queued: true, submissionId: "sub-2" });
    expect(state.reads - readsBefore).toBe(1);

    // Same student again: resume, zero reads (config + enrolled + seeded).
    const resumeBefore = state.reads;
    const resume = await doStart(store, cfg, db, STUDENT, "sub-9");
    expect(resume).toEqual({ queued: false, submissionId: "sub-1" });
    expect(state.reads - resumeBefore).toBe(0);
  });

  it("computes expiresAt from duration_minutes", async () => {
    const state = fakeState();
    const db = makeFakeDb(state);
    const store = new MapStore();
    const cfg = new MapConfigStore();
    await doStart(store, cfg, db);
    expect((await store.getSubmission("sub-1"))?.expiresAt).toBe("2026-11-10T18:00:00.000Z");
  });

  it("picks up a late approval via the D1 gate fallback (denials are never cached)", async () => {
    const state = fakeState();
    const db = makeFakeDb(state);
    const store = new MapStore();
    const cfg = new MapConfigStore();
    const LATE = "student-3";
    await expect(
      validateStart(store, cfg, db, { studentId: LATE, assessmentId: EXAM, nowIso: NOW }),
    ).rejects.toThrow("TAKE_NOT_ASSIGNED");
    // The teacher approves them after the config loaded.
    state.assignments.push(LATE);
    state.members.push({ group_id: "g-1", student_id: LATE, status: "approved" });
    const ok = await validateStart(store, cfg, db, {
      studentId: LATE,
      assessmentId: EXAM,
      nowIso: NOW,
    });
    expect(ok).toMatchObject({ attemptNumber: 1, totalPossible: 15 });
    // And now they are cached: a re-validation costs zero reads.
    const before = state.reads;
    await validateStart(store, cfg, db, { studentId: LATE, assessmentId: EXAM, nowIso: NOW });
    expect(state.reads - before).toBe(0);
  });

  it("rejects unpublished and window-closed exams", async () => {
    const state = fakeState();
    state.assessment.status = "draft";
    const db = makeFakeDb(state);
    await expect(
      validateStart(new MapStore(), new MapConfigStore(), db, {
        studentId: STUDENT,
        assessmentId: EXAM,
        nowIso: NOW,
      }),
    ).rejects.toThrow("TAKE_NOT_PUBLISHED");

    const state2 = fakeState();
    state2.assessment.due_at = "2026-11-10T16:00:00.000Z";
    const db2 = makeFakeDb(state2);
    await expect(
      validateStart(new MapStore(), new MapConfigStore(), db2, {
        studentId: STUDENT,
        assessmentId: EXAM,
        nowIso: NOW,
      }),
    ).rejects.toThrow("TAKE_WINDOW_CLOSED");
  });

  it("enforces max_attempts including pre-DO history (seeded)", async () => {
    const state = fakeState();
    state.assessment.max_attempts = 1;
    state.submissions["old-1"] = {
      id: "old-1",
      assessment_id: EXAM,
      student_id: STUDENT,
      status: "awaiting_review",
      attempt_number: 1,
      started_at: NOW,
      submitted_at: NOW,
      expires_at: null,
      question_order: JSON.stringify([Q1]),
      total_possible: 15,
      draft_seq: 0,
    };
    const db = makeFakeDb(state);
    await expect(
      validateStart(new MapStore(), new MapConfigStore(), db, {
        studentId: STUDENT,
        assessmentId: EXAM,
        nowIso: NOW,
      }),
    ).rejects.toThrow("TAKE_NO_ATTEMPTS_LEFT");
  });

  it("reloads the config after the TTL", async () => {
    const state = fakeState();
    const db = makeFakeDb(state);
    const store = new MapStore();
    const cfg = new MapConfigStore();
    await doStart(store, cfg, db);
    const before = state.reads;
    // Age the config past the TTL relative to the test clock (NOW);
    // the next start reloads it (5 reads for the config + 1 for the
    // second student's one-time seed).
    if (cfg.config) cfg.config.loadedAt = Date.parse(NOW) - TAKE_SESSION_CACHE_TTL_MS - 1;
    await doStart(store, cfg, db, OTHER, "sub-2");
    expect(state.reads - before).toBe(6);
  });
});

describe("getCachedMarks (V2 cache)", () => {
  it("loads marks once, then serves them from the cache", async () => {
    const state = fakeState();
    const db = makeFakeDb(state);
    const cfg = new MapConfigStore();
    expect(await getCachedMarks(cfg, db, EXAM, Date.now())).toEqual(MARKS);
    const before = state.reads;
    expect(await getCachedMarks(cfg, db, EXAM, Date.now())).toEqual(MARKS);
    expect(state.reads - before).toBe(0);
  });
});
