/**
 * Tests for the Phase 3 take queue (src/server/d1-take.ts producers,
 * src/server/take-queue.ts consumer). Uses a dispatch fake for
 * D1Database (same pattern as src/test/d1-take-routes.test.ts):
 * in-memory rows, every SQL string recorded, so the tests prove
 * producer enqueue, consumer idempotency, retry behaviour, and the
 * student-visible status transitions without a Worker binding or a
 * live D1.
 *
 * The fake executes writes at run()/batch() time (like real D1), so
 * the guard-claim + conditional-write ordering in applyDraftAnswers
 * is exercised faithfully, including a transient failure injected
 * between the claim and the answer writes.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";
import { setTakeQueueBinding, type TakeQueueBindingLike } from "@/server/d1";
import {
  enqueueTakeMessage,
  getTakeStatus,
  loadDraftTarget,
  resolveStart,
  type TakeQueueMessage,
} from "@/server/d1-take";
import {
  handleTakeQueueBatch,
  processTakeMessage,
  TAKE_QUEUE_MAX_RETRIES,
  type TakeQueueBatch,
  type TakeQueueMessageHandle,
} from "@/server/take-queue";

const NOW = "2026-11-03T20:00:00.000Z";

type SubmissionState = {
  id: string;
  assessment_id: string;
  student_id: string;
  status: string;
  attempt_number: number;
  started_at: string | null;
  submitted_at: string | null;
  expires_at: string | null;
  question_order: string | null;
  final_score: number | null;
  total_possible: number;
  draft_seq: number;
};

type State = {
  assessments: Record<
    string,
    {
      status: string;
      starts_at: string | null;
      due_at: string | null;
      max_attempts: number;
      duration_minutes: number | null;
      title: string;
    }
  >;
  assignments: Set<string>;
  groupLinks: Record<string, string[]>;
  approvedMembers: Set<string>;
  questions: Record<string, { id: string; prompt: string; type: string; marks: number }[]>;
  submissions: SubmissionState[];
  answers: { id: string; submission_id: string; question_id: string; response: string }[];
  failures: {
    submission_id: string | null;
    message_type: string;
    reason: string;
    attempts: number;
  }[];
  audit: { action: string; entity_id: string }[];
  sent: TakeQueueMessage[];
  seen: string[];
  // Transient-failure injection: the next `times` prepare() calls whose
  // SQL includes `fragment` throw a D1 overload error.
  failSql: { fragment: string; times: number } | null;
};

function baseState(): State {
  return {
    assessments: {
      ex1: {
        status: "published",
        starts_at: null,
        due_at: null,
        max_attempts: 2,
        duration_minutes: 30,
        title: "Exam 1",
      },
    },
    assignments: new Set(["ex1:student-a"]),
    groupLinks: { ex1: ["group-1"] },
    approvedMembers: new Set(["group-1:student-a"]),
    questions: {
      ex1: [
        { id: "q1", prompt: "2 + 2?", type: "mcq", marks: 5 },
        { id: "q2", prompt: "Explain.", type: "written", marks: 5 },
      ],
    },
    submissions: [],
    answers: [],
    failures: [],
    audit: [],
    sent: [],
    seen: [],
    failSql: null,
  };
}

function fakeQueue(state: State): TakeQueueBindingLike {
  return {
    send: async (message: TakeQueueMessage) => {
      state.sent.push(message);
    },
    sendBatch: async (batch: { messages: TakeQueueMessage[] }) => {
      state.sent.push(...batch.messages);
    },
  } as TakeQueueBindingLike;
}

function submissionRow(s: SubmissionState): Record<string, unknown> {
  return { ...s };
}

/** A bound statement: writes apply at run()/batch() time, like D1. */
type BoundStmt = {
  _apply: () => { meta: { changes: number } };
  _result?: { meta: { changes: number } };
  bind: (...p: unknown[]) => BoundStmt;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results?: T[] }>;
  run: () => Promise<{ meta: { changes: number } }>;
};

function fakeDb(state: State): D1Database {
  const kindOf = (sql: string): string => {
    if (sql.startsWith("SELECT title FROM assessments")) return "assessment-title";
    if (sql.includes("FROM assessments") && sql.includes("WHERE id = ?")) return "assessment";
    if (sql.includes("FROM assessment_assignments")) return "assignment";
    if (sql.includes("FROM group_exams")) return "links";
    if (sql.includes("FROM group_members")) return "member";
    if (sql.includes("FROM questions") && sql.includes("ORDER BY position")) return "questions";
    if (
      sql.includes(
        "FROM submissions WHERE assessment_id = ? AND student_id = ? AND status = 'in_progress'",
      )
    )
      return "draft";
    if (sql.startsWith("SELECT COUNT(*) AS n FROM submissions")) return "count-submissions";
    if (sql.includes("SUM(marks)")) return "sum-marks";
    if (sql.startsWith("SELECT * FROM submissions WHERE id = ?")) return "submission-by-id";
    if (sql.startsWith("SELECT id FROM submissions WHERE id = ?")) return "submission-id-only";
    if (sql.startsWith("SELECT draft_seq FROM submissions")) return "draft-seq";
    if (sql.startsWith("SELECT status FROM submissions")) return "submission-status";
    if (sql.startsWith("SELECT due_at FROM assessments")) return "due";
    if (sql.startsWith("SELECT reason FROM take_write_failures")) return "failure-by-submission";
    if (sql.startsWith("SELECT question_id, response FROM answers")) return "answers-by-submission";
    if (sql.includes("LEFT JOIN answers a ON a.question_id = q.id")) return "draft-answer-lookup";
    if (sql.startsWith("SELECT submission_id, question_id, response FROM answers"))
      return "answers";
    return "unknown";
  };

  const firstFor = (kind: string, params: unknown[]): unknown => {
    if (kind === "assessment" || kind === "assessment-title") {
      const row = state.assessments[params[0] as string];
      if (!row) return null;
      return kind === "assessment-title"
        ? { title: row.title }
        : {
            id: params[0],
            title: row.title,
            instructions: "",
            status: row.status,
            starts_at: row.starts_at,
            due_at: row.due_at,
            max_attempts: row.max_attempts,
            duration_minutes: row.duration_minutes,
          };
    }
    if (kind === "assignment")
      return state.assignments.has(`${params[0]}:${params[1]}`) ? { one: 1 } : null;
    if (kind === "member")
      return state.approvedMembers.has(`${params[0]}:${params[1]}`) ? { one: 1 } : null;
    if (kind === "draft") {
      const rows = state.submissions
        .filter(
          (s) =>
            s.assessment_id === params[0] &&
            s.student_id === params[1] &&
            s.status === "in_progress",
        )
        .sort((a, b) => b.attempt_number - a.attempt_number);
      const row = rows[0];
      return row ? { id: row.id, draft_seq: row.draft_seq } : null;
    }
    if (kind === "count-submissions") {
      const n = state.submissions.filter(
        (s) => s.assessment_id === params[0] && s.student_id === params[1],
      ).length;
      return { n };
    }
    if (kind === "sum-marks") {
      const rows = state.questions[params[0] as string] ?? [];
      return { total: rows.reduce((sum, q) => sum + q.marks, 0) };
    }
    if (kind === "submission-by-id") {
      const row = state.submissions.find((s) => s.id === params[0]);
      return row ? submissionRow(row) : null;
    }
    if (kind === "submission-id-only") {
      const row = state.submissions.find((s) => s.id === params[0]);
      return row ? { id: row.id } : null;
    }
    if (kind === "draft-seq") {
      const row = state.submissions.find((s) => s.id === params[0]);
      return row ? { draft_seq: row.draft_seq } : null;
    }
    if (kind === "submission-status") {
      const row = state.submissions.find((s) => s.id === params[0]);
      return row ? { status: row.status } : null;
    }
    if (kind === "due") {
      const row = state.assessments[params[0] as string];
      return row ? { due_at: row.due_at } : null;
    }
    if (kind === "failure-by-submission") {
      const row = [...state.failures].reverse().find((f) => f.submission_id === params[0]);
      return row ? { reason: row.reason } : null;
    }
    return null;
  };

  const allFor = (kind: string, params: unknown[]): { results?: unknown[] } => {
    if (kind === "links") {
      const ids = state.groupLinks[params[0] as string] ?? [];
      return { results: ids.map((group_id) => ({ group_id })) };
    }
    if (kind === "questions") {
      const rows = state.questions[params[0] as string] ?? [];
      return { results: rows.map((q) => ({ ...q, options: "[]", position: 0 })) };
    }
    if (kind === "answers-by-submission") {
      const rows = state.answers.filter((a) => a.submission_id === params[0]);
      return {
        results: rows.map((a) => ({ question_id: a.question_id, response: a.response })),
      };
    }
    if (kind === "answers") {
      const ids = params as string[];
      return { results: state.answers.filter((a) => ids.includes(a.submission_id)) };
    }
    if (kind === "draft-answer-lookup") {
      const submissionId = params[0] as string;
      const assessmentId = params[1] as string;
      const ids = params.slice(2) as string[];
      const questions = (state.questions[assessmentId] ?? []).filter((q) => ids.includes(q.id));
      return {
        results: questions.map((q) => ({
          question_id: q.id,
          marks: q.marks,
          answer_id: state.answers.some(
            (a) => a.submission_id === submissionId && a.question_id === q.id,
          )
            ? state.answers.find((a) => a.submission_id === submissionId && a.question_id === q.id)!
                .id
            : null,
        })),
      };
    }
    return { results: [] };
  };

  /** The write effect for a statement, run at run()/batch() time. */
  const applyFor = (sql: string, params: unknown[]): { meta: { changes: number } } => {
    if (sql.startsWith("INSERT INTO submissions")) {
      const [id, assessmentId, studentId, attemptNumber] = params as [
        string,
        string,
        string,
        number,
      ];
      const duplicate =
        state.submissions.some((s) => s.id === id) ||
        state.submissions.some(
          (s) =>
            s.assessment_id === assessmentId &&
            s.student_id === studentId &&
            s.status === "in_progress",
        );
      if (duplicate) {
        throw new Error("UNIQUE constraint failed: submissions.id (or one-in-progress index)");
      }
      state.submissions.push({
        id,
        assessment_id: assessmentId,
        student_id: studentId,
        status: "in_progress",
        attempt_number: attemptNumber,
        started_at: params[4] as string,
        submitted_at: params[5] as string,
        expires_at: params[6] as string | null,
        question_order: params[7] as string,
        final_score: null,
        total_possible: params[8] as number,
        draft_seq: 0,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE submissions SET draft_seq")) {
      const [seq, id] = params as [number, string];
      const row = state.submissions.find((s) => s.id === id);
      if (row && row.draft_seq < seq) {
        row.draft_seq = seq;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.startsWith("UPDATE submissions SET status")) {
      const [submittedAt, id] = params as [string, string];
      const row = state.submissions.find((s) => s.id === id);
      if (row) {
        row.status = "awaiting_review";
        row.submitted_at = submittedAt;
      }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (sql.startsWith("INSERT INTO answers")) {
      const isQueued = sql.includes("SELECT ?, ?, ?, ?, ?, 'not_graded', ? WHERE");
      if (isQueued) {
        // Queued path: (id, submission, question, response, marks, time,
        // submissionId, seq) — applies only while the claim is current.
        const seq = params[7] as number;
        const row = state.submissions.find((s) => s.id === (params[6] as string));
        if (!row || row.draft_seq !== seq) return { meta: { changes: 0 } };
      }
      const [answerId, submissionId, questionId, response] = params as [
        string,
        string,
        string,
        string,
      ];
      const existing = state.answers.find(
        (a) => a.submission_id === submissionId && a.question_id === questionId,
      );
      if (existing) existing.response = response;
      else
        state.answers.push({
          id: answerId,
          submission_id: submissionId,
          question_id: questionId,
          response,
        });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE answers SET")) {
      const isQueued = sql.includes("(SELECT draft_seq FROM submissions WHERE id = ?) = ?");
      if (isQueued) {
        const seq = params[4] as number;
        const row = state.submissions.find((s) => s.id === (params[3] as string));
        if (!row || row.draft_seq !== seq) return { meta: { changes: 0 } };
        const answer = state.answers.find((a) => a.id === (params[2] as string));
        if (answer) answer.response = params[0] as string;
        return { meta: { changes: answer ? 1 : 0 } };
      }
      const answer = state.answers.find((a) => a.id === (params[2] as string));
      if (answer) answer.response = params[0] as string;
      return { meta: { changes: answer ? 1 : 0 } };
    }
    if (sql.startsWith("INSERT INTO audit_log")) {
      // markSubmitted binds (actor, action, entity, details).
      state.audit.push({ action: params[1] as string, entity_id: params[2] as string });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO take_write_failures")) {
      state.failures.push({
        submission_id: params[2] as string | null,
        message_type: params[4] as string,
        reason: params[5] as string,
        attempts: params[6] as number,
      });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  };

  const makeStmt = (sql: string, params: unknown[]): BoundStmt => {
    const stmt = {
      _apply: () => applyFor(sql, params),
      bind: (...p: unknown[]) => makeStmt(sql, p),
      first: async <T>() => firstFor(kindOf(sql), params) as T | null,
      all: async <T>() => allFor(kindOf(sql), params) as { results?: T[] },
      run: async () => stmt._apply(),
    } as BoundStmt;
    return stmt;
  };

  return {
    prepare(sql: string): D1Statement {
      state.seen.push(sql);
      if (state.failSql && sql.includes(state.failSql.fragment) && state.failSql.times > 0) {
        state.failSql.times -= 1;
        throw new Error("D1_ERROR: D1 DB is overloaded");
      }
      return makeStmt(sql, []) as unknown as D1Statement;
    },
    batch: async (statements: D1Statement[]) => {
      const results: { meta: { changes: number } }[] = [];
      for (const statement of statements) {
        results.push((statement as unknown as BoundStmt)._apply());
      }
      return results as never;
    },
  } as unknown as D1Database;
}

function makeSubmission(state: State, overrides: Partial<SubmissionState> = {}): string {
  const id = overrides.id ?? "sub-1";
  state.submissions.push({
    id,
    assessment_id: "ex1",
    student_id: "student-a",
    status: "in_progress",
    attempt_number: 1,
    started_at: NOW,
    submitted_at: NOW,
    expires_at: null,
    question_order: JSON.stringify(["q1", "q2"]),
    final_score: null,
    total_possible: 10,
    draft_seq: 0,
    ...overrides,
  });
  return id;
}

function startMessage(overrides: Partial<Extract<TakeQueueMessage, { type: "start" }>> = {}) {
  return {
    v: 1 as const,
    type: "start" as const,
    id: "msg-start-1",
    submissionId: "sub-1",
    studentId: "student-a",
    assessmentId: "ex1",
    questionOrder: ["q1", "q2"],
    sentAt: NOW,
    ...overrides,
  };
}

function draftMessage(overrides: Partial<Extract<TakeQueueMessage, { type: "draft" }>> = {}) {
  return {
    v: 1 as const,
    type: "draft" as const,
    id: "msg-draft-1",
    submissionId: "sub-1",
    studentId: "student-a",
    seq: 1,
    answers: [{ question_id: "q1", response: "4", time_spent_seconds: 5 }],
    sentAt: NOW,
    ...overrides,
  };
}

function submitMessage(overrides: Partial<Extract<TakeQueueMessage, { type: "submit" }>> = {}) {
  return {
    v: 1 as const,
    type: "submit" as const,
    id: "msg-submit-1",
    submissionId: "sub-1",
    studentId: "student-a",
    seq: 2,
    answers: [
      { question_id: "q1", response: "4", time_spent_seconds: 5 },
      { question_id: "q2", response: "Because.", time_spent_seconds: 10 },
    ],
    sentAt: NOW,
    ...overrides,
  };
}

function handle(
  body: TakeQueueMessage,
  attempts = 0,
): {
  message: TakeQueueMessageHandle<TakeQueueMessage>;
  acked: () => boolean;
  retried: () => boolean;
} {
  let ack = false;
  let retry = false;
  const message: TakeQueueMessageHandle<TakeQueueMessage> = {
    id: body.id,
    body,
    attempts,
    ack: () => {
      ack = true;
    },
    retry: () => {
      retry = true;
    },
  };
  return { message, acked: () => ack, retried: () => retry };
}

afterEach(() => {
  setTakeQueueBinding(null);
});

describe("take-queue: producer enqueue", () => {
  it("a start validates with reads only, then enqueues — no row is created by the producer", async () => {
    const state = baseState();
    const db = fakeDb(state);
    setTakeQueueBinding(fakeQueue(state));
    const resolved = await resolveStart(db, "student-a", "ex1", NOW);
    expect(resolved.existingId).toBeNull();
    await enqueueTakeMessage(startMessage());
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toMatchObject({
      type: "start",
      submissionId: "sub-1",
      studentId: "student-a",
      assessmentId: "ex1",
    });
    // The producer wrote nothing: the row appears only after the
    // consumer applies the message.
    expect(state.submissions).toHaveLength(0);
    expect(state.seen.some((sql) => sql.startsWith("INSERT INTO submissions"))).toBe(false);
  });

  it("enqueue throws TAKE_QUEUE_NOT_WIRED when no queue is wired", async () => {
    setTakeQueueBinding(null);
    await expect(enqueueTakeMessage(startMessage())).rejects.toThrow("TAKE_QUEUE_NOT_WIRED");
  });

  it("a draft validates its target, then enqueues with seq + answers", async () => {
    const state = baseState();
    makeSubmission(state);
    const db = fakeDb(state);
    setTakeQueueBinding(fakeQueue(state));
    const target = await loadDraftTarget(db, "student-a", "sub-1", NOW);
    expect(target?.editable).toBe(true);
    await enqueueTakeMessage(draftMessage());
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toMatchObject({ type: "draft", seq: 1 });
    expect((state.sent[0] as Extract<TakeQueueMessage, { type: "draft" }>).answers).toEqual([
      { question_id: "q1", response: "4", time_spent_seconds: 5 },
    ]);
    expect(state.answers).toHaveLength(0);
  });

  it("a submit enqueues the FULL final answers with a seq", async () => {
    const state = baseState();
    makeSubmission(state);
    const db = fakeDb(state);
    setTakeQueueBinding(fakeQueue(state));
    await enqueueTakeMessage(submitMessage());
    expect(state.sent).toHaveLength(1);
    const sent = state.sent[0] as Extract<TakeQueueMessage, { type: "submit" }>;
    expect(sent.answers).toHaveLength(2);
    expect(sent.seq).toBe(2);
    expect(state.submissions[0]!.status).toBe("in_progress");
  });
});

describe("take-queue: student status transitions", () => {
  it("pending → started → submitted, driven by the consumer", async () => {
    const state = baseState();
    const db = fakeDb(state);
    expect(await getTakeStatus(db, "student-a", "sub-1", "ex1")).toEqual({
      status: "pending",
    });
    await processTakeMessage(db, startMessage(), NOW);
    expect(await getTakeStatus(db, "student-a", "sub-1", "ex1")).toEqual({
      status: "started",
      submissionId: "sub-1",
      lastAppliedDraftSeq: 0,
      redirected: false,
    });
    await processTakeMessage(db, draftMessage(), NOW);
    expect(await getTakeStatus(db, "student-a", "sub-1", "ex1")).toMatchObject({
      status: "started",
      lastAppliedDraftSeq: 1,
    });
    await processTakeMessage(db, submitMessage(), NOW);
    expect(await getTakeStatus(db, "student-a", "sub-1", "ex1")).toEqual({
      status: "submitted",
      submissionId: "sub-1",
      lastAppliedDraftSeq: 1,
    });
  });

  it("a start that resolves to an existing draft reports it as redirected", async () => {
    const state = baseState();
    makeSubmission(state, { id: "sub-existing" });
    const db = fakeDb(state);
    // The client asked for a fresh id, but a draft already exists.
    expect(await getTakeStatus(db, "student-a", "sub-fresh", "ex1")).toEqual({
      status: "started",
      submissionId: "sub-existing",
      lastAppliedDraftSeq: 0,
      redirected: true,
    });
  });

  it("a permanent failure surfaces as failed with the reason", async () => {
    const state = baseState();
    state.assessments["ex1"]!.status = "draft";
    const db = fakeDb(state);
    const { message, acked } = handle(startMessage());
    await handleTakeQueueBatch({ messages: [message] }, { DB: db }, NOW);
    expect(acked()).toBe(true);
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]!.reason).toMatch(/^TAKE_/);
    expect(await getTakeStatus(db, "student-a", "sub-1", "ex1")).toEqual({
      status: "failed",
      reason: state.failures[0]!.reason,
    });
  });

  it("another student's row never leaks through a guessed submission id", async () => {
    const state = baseState();
    makeSubmission(state);
    const db = fakeDb(state);
    expect(await getTakeStatus(db, "student-b", "sub-1", "ex1")).toEqual({
      status: "pending",
    });
  });
});

describe("take-queue: consumer idempotency", () => {
  it("the same start message twice creates exactly one submission", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await processTakeMessage(db, startMessage(), NOW);
    await processTakeMessage(db, startMessage(), NOW);
    expect(state.submissions).toHaveLength(1);
    expect(state.submissions[0]!.id).toBe("sub-1");
  });

  it("a second start with a different id resolves to the existing draft", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await processTakeMessage(db, startMessage(), NOW);
    await processTakeMessage(db, startMessage({ id: "msg-start-2", submissionId: "sub-2" }), NOW);
    expect(state.submissions).toHaveLength(1);
    expect(state.submissions[0]!.id).toBe("sub-1");
  });

  it("the same draft message twice writes the answers once", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await processTakeMessage(db, startMessage(), NOW);
    await processTakeMessage(db, draftMessage(), NOW);
    await processTakeMessage(db, draftMessage(), NOW);
    expect(state.answers).toHaveLength(1);
    expect(state.answers[0]).toMatchObject({ question_id: "q1", response: "4" });
    expect(state.submissions[0]!.draft_seq).toBe(1);
  });

  it("an older draft seq after a newer one is skipped — the newer answers stand", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await processTakeMessage(db, startMessage(), NOW);
    await processTakeMessage(
      db,
      draftMessage({
        id: "msg-draft-2",
        seq: 2,
        answers: [{ question_id: "q1", response: "new", time_spent_seconds: 6 }],
      }),
      NOW,
    );
    await processTakeMessage(
      db,
      draftMessage({
        id: "msg-draft-1",
        seq: 1,
        answers: [{ question_id: "q1", response: "old", time_spent_seconds: 5 }],
      }),
      NOW,
    );
    expect(state.answers).toHaveLength(1);
    expect(state.answers[0]!.response).toBe("new");
    expect(state.submissions[0]!.draft_seq).toBe(2);
  });

  it("a mid-write failure is healed by the retry: the claim is re-applied, not lost", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await processTakeMessage(db, startMessage(), NOW);
    // The answer INSERT fails once with D1 overload — after the seq
    // claim landed. The internal retry re-runs the draft: draft_seq
    // already equals seq, so the stored answers are compared and the
    // missing one is re-applied.
    state.failSql = { fragment: "INSERT INTO answers", times: 1 };
    await processTakeMessage(db, draftMessage(), NOW);
    expect(state.answers).toHaveLength(1);
    expect(state.answers[0]).toMatchObject({ question_id: "q1", response: "4" });
    expect(state.submissions[0]!.draft_seq).toBe(1);
  });

  it("the same submit message twice flips the status and audits once", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await processTakeMessage(db, startMessage(), NOW);
    await processTakeMessage(db, submitMessage(), NOW);
    await processTakeMessage(db, submitMessage(), NOW);
    expect(state.submissions[0]!.status).toBe("awaiting_review");
    expect(state.audit.filter((a) => a.action === "exam_submitted")).toHaveLength(1);
  });

  it("submit is the source of truth: it writes answers even with no draft saved", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await processTakeMessage(db, startMessage(), NOW);
    await processTakeMessage(db, submitMessage(), NOW);
    expect(state.answers).toHaveLength(2);
    expect(state.submissions[0]!.status).toBe("awaiting_review");
  });

  it("a late draft after submit is dropped, never overwriting the final answers", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await processTakeMessage(db, startMessage(), NOW);
    await processTakeMessage(db, submitMessage(), NOW);
    const { message, acked } = handle(
      draftMessage({
        id: "msg-draft-late",
        seq: 3,
        answers: [{ question_id: "q1", response: "late", time_spent_seconds: 1 }],
      }),
    );
    await handleTakeQueueBatch({ messages: [message] }, { DB: db }, NOW);
    expect(acked()).toBe(true);
    expect(state.answers.find((a) => a.question_id === "q1")!.response).toBe("4");
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]!.message_type).toBe("draft");
  });
});

describe("take-queue: retry + failure handling", () => {
  it("a transient failure past the internal retries is retried, then succeeds on redelivery", async () => {
    const state = baseState();
    const db = fakeDb(state);
    // The INSERT fails 10 times — past the 3 internal retries.
    state.failSql = { fragment: "INSERT INTO submissions", times: 10 };
    const first = handle(startMessage());
    await handleTakeQueueBatch({ messages: [first.message] }, { DB: db }, NOW);
    expect(first.retried()).toBe(true);
    expect(first.acked()).toBe(false);
    expect(state.submissions).toHaveLength(0);
    // Not a failure row yet: the queue still has retries left.
    expect(state.failures).toHaveLength(0);
    // Redelivery, D1 healthy again: exactly one row.
    state.failSql = null;
    const second = handle(startMessage());
    await handleTakeQueueBatch({ messages: [second.message] }, { DB: db }, NOW);
    expect(second.acked()).toBe(true);
    expect(state.submissions).toHaveLength(1);
  });

  it("a permanent gate failure is recorded and acked, never retried", async () => {
    const state = baseState();
    state.assessments["ex1"]!.status = "draft";
    const db = fakeDb(state);
    const { message, acked, retried } = handle(startMessage());
    await handleTakeQueueBatch({ messages: [message] }, { DB: db }, NOW);
    expect(acked()).toBe(true);
    expect(retried()).toBe(false);
    expect(state.submissions).toHaveLength(0);
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]).toMatchObject({ message_type: "start" });
    expect(state.failures[0]!.reason).toMatch(/^TAKE_/);
  });

  it("on the last attempt a transient failure is recorded for the DLQ and retried", async () => {
    const state = baseState();
    const db = fakeDb(state);
    state.failSql = { fragment: "INSERT INTO submissions", times: 10 };
    const { message, retried } = handle(startMessage(), TAKE_QUEUE_MAX_RETRIES);
    await handleTakeQueueBatch({ messages: [message] }, { DB: db }, NOW);
    expect(retried()).toBe(true);
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]!.reason).toMatch(/^DLQ:/);
    expect(state.failures[0]!.attempts).toBe(TAKE_QUEUE_MAX_RETRIES);
  });

  it("a poison message does not block the rest of the batch", async () => {
    const state = baseState();
    const db = fakeDb(state);
    // The draft target does not exist: permanent (TAKE_NOT_FOUND).
    const bad = handle(draftMessage({ id: "msg-bad" }));
    const good = handle(startMessage({ id: "msg-good" }));
    const batch: TakeQueueBatch<TakeQueueMessage> = {
      messages: [bad.message, good.message],
    };
    await handleTakeQueueBatch(batch, { DB: db }, NOW);
    expect(bad.acked()).toBe(true);
    expect(good.acked()).toBe(true);
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]!.message_type).toBe("draft");
    // The good message still applied — one poison message cannot
    // requeue (or drop) the whole batch.
    expect(state.submissions).toHaveLength(1);
  });

  it("the consumer throws when the D1 binding is missing", async () => {
    const { message } = handle(startMessage());
    await expect(handleTakeQueueBatch({ messages: [message] }, {}, NOW)).rejects.toThrow(
      "TAKE_QUEUE_NO_DB",
    );
  });
});
