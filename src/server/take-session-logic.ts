/**
 * Take-session live state logic (Phase 4, Durable Objects).
 *
 * Pure functions over a SessionStore interface — no DO globals here,
 * so this module is unit-testable with a Map-backed store (vitest).
 * The production store is the DO SQLite adapter in take-session.ts;
 * the DO class itself is the thin runtime wrapper (fetch routing,
 * alarm, hydration) and is verified live, not unit-tested.
 *
 * State model (DESIGN.md §4): the DO's SQLite storage IS the live
 * session state. A submission's answers live there with the marks
 * the serverFn supplied (§4 — the DO holds no question data). D1 is
 * the durable record: the flush (§5) reuses the existing D1
 * functions (insertSubmission / applyDraftAnswers / markSubmitted),
 * so no new D1-write code exists anywhere in this phase.
 *
 * Idempotency mirrors Phase 3: start by submissionId (PK), draft by
 * (submissionId, seq) against draft_seq, submit by submissionId +
 * status check. The DO is the single writer for its submissions, so
 * the D1 side needs no seq guard on flush (seq=null path).
 */

import type { D1Database } from "@/server/d1-auth-store";
import {
  applyDraftAnswers,
  insertSubmission,
  markSubmitted,
  recordTakeFailure,
  type DraftAnswerInput,
  type SubmissionRow,
  type TakeStatus,
} from "@/server/d1-take";
import { retryD1Overload } from "@/server/d1-retry";

/** One submission as the DO holds it (mirrors the D1 row, plus the
 *  flush bookkeeping D1 never sees). */
export type DoSubmissionState = {
  id: string;
  assessmentId: string;
  studentId: string;
  status: "in_progress" | "awaiting_review";
  attemptNumber: number;
  startedAt: string;
  submittedAt: string | null;
  expiresAt: string | null;
  questionOrder: string[];
  totalPossible: number;
  draftSeq: number;
  dirty: boolean;
  flushAttempts: number;
  flushError: string | null;
  updatedAt: string;
};

export type DoAnswerState = {
  questionId: string;
  response: string;
  maxMarks: number;
  timeSpentSeconds: number;
};

/** The store surface the logic needs. The production implementation
 *  is the DO SQLite adapter (take-session.ts); tests use a Map. */
export interface SessionStore {
  getSubmission(id: string): Promise<DoSubmissionState | null>;
  putSubmission(sub: DoSubmissionState): Promise<void>;
  getAnswers(submissionId: string): Promise<DoAnswerState[]>;
  upsertAnswers(submissionId: string, answers: DoAnswerState[]): Promise<void>;
  listDirty(limit: number): Promise<DoSubmissionState[]>;
  markClean(id: string): Promise<void>;
  bumpFlushAttempt(id: string, error: string): Promise<number>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/** Flush is recorded as a failure after this many failed cycles —
 *  the same visibility the queue's DLQ gave (DESIGN.md §5). */
export const TAKE_SESSION_FLUSH_MAX_ATTEMPTS = 3;

/** How many dirty submissions one alarm run flushes (oldest first).
 *  Small on purpose: a flush is several D1 statements, and the alarm
 *  re-arms while dirty rows remain. */
export const TAKE_SESSION_FLUSH_BATCH = 20;

export type StartInput = {
  submissionId: string;
  studentId: string;
  assessmentId: string;
  questionOrder: string[];
  attemptNumber: number;
  totalPossible: number;
  expiresAt: string | null;
  nowIso: string;
};

export type DraftInput = {
  submissionId: string;
  studentId: string;
  answers: DraftAnswerInput[];
  seq: number;
  /** question_id → marks, from the serverFn's one D1 read (§4). The
   *  DO holds no question data; unknown questions are dropped. */
  marks: Record<string, number>;
};

export type SubmitInput = {
  submissionId: string;
  studentId: string;
  answers: DraftAnswerInput[];
  seq: number;
  marks: Record<string, number>;
  nowIso: string;
};

function notFound(): Error {
  return new Error("TAKE_NOT_FOUND");
}

function validAnswers(
  answers: DraftAnswerInput[],
  marks: Record<string, number>,
): DoAnswerState[] {
  const byQuestion = new Map<string, DoAnswerState>();
  for (const answer of answers.slice(0, 500)) {
    const maxMarks = marks[answer.question_id];
    if (maxMarks === undefined) continue; // unknown question: dropped
    byQuestion.set(answer.question_id, {
      questionId: answer.question_id,
      response: answer.response ?? "",
      maxMarks,
      timeSpentSeconds: Math.max(0, Math.round(answer.time_spent_seconds || 0)),
    });
  }
  return [...byQuestion.values()];
}

/** Start a submission in the DO. Idempotent by submissionId: a
 *  duplicate start returns the existing id (the client generated it,
 *  so a retry after a dropped response lands on the same row). A
 *  submissionId owned by another student/assessment is rejected. */
export async function applyStart(
  store: SessionStore,
  input: StartInput,
): Promise<{ submissionId: string }> {
  const existing = await store.getSubmission(input.submissionId);
  if (existing) {
    if (existing.studentId !== input.studentId || existing.assessmentId !== input.assessmentId)
      throw notFound();
    return { submissionId: existing.id };
  }
  await store.transaction(async () => {
    await store.putSubmission({
      id: input.submissionId,
      assessmentId: input.assessmentId,
      studentId: input.studentId,
      status: "in_progress",
      attemptNumber: input.attemptNumber,
      startedAt: input.nowIso,
      submittedAt: null,
      expiresAt: input.expiresAt,
      questionOrder: input.questionOrder.slice(0, 500),
      totalPossible: input.totalPossible,
      draftSeq: 0,
      dirty: true,
      flushAttempts: 0,
      flushError: null,
      updatedAt: input.nowIso,
    });
  });
  return { submissionId: input.submissionId };
}

export type DraftResult =
  | { applied: "applied"; lastAppliedDraftSeq: number }
  | { applied: "duplicate"; lastAppliedDraftSeq: number }
  | { applied: "not_editable"; lastAppliedDraftSeq: number };

/** Apply a draft. The seq guard is the ordering authority: an older
 *  seq is dropped (a newer one already landed), the same seq is a
 *  duplicate re-apply (idempotent upsert — a retry after a dropped
 *  response is a no-op), a newer seq applies. A frozen submission
 *  (already submitted) is not editable — the caller maps that to
 *  { ok: false } exactly as the Phase 3 validation failure. */
export async function applyDraft(store: SessionStore, input: DraftInput): Promise<DraftResult> {
  const sub = await store.getSubmission(input.submissionId);
  if (!sub || sub.studentId !== input.studentId) throw notFound();
  if (sub.status !== "in_progress")
    return { applied: "not_editable", lastAppliedDraftSeq: sub.draftSeq };
  if (input.seq < sub.draftSeq)
    return { applied: "duplicate", lastAppliedDraftSeq: sub.draftSeq };
  if (input.seq === sub.draftSeq) {
    // Same seq: re-apply (upsert is idempotent) so a retry after a
    // dropped response converges instead of reporting a false loss.
    const answers = validAnswers(input.answers, input.marks);
    await store.transaction(async () => {
      await store.upsertAnswers(sub.id, answers);
    });
    return { applied: "duplicate", lastAppliedDraftSeq: sub.draftSeq };
  }
  const answers = validAnswers(input.answers, input.marks);
  await store.transaction(async () => {
    await store.upsertAnswers(sub.id, answers);
    await store.putSubmission({
      ...sub,
      draftSeq: input.seq,
      dirty: true,
      updatedAt: new Date().toISOString(),
    });
  });
  return { applied: "applied", lastAppliedDraftSeq: input.seq };
}

export type SubmitResult = { submitted: boolean };

/** Apply a submit. The FULL final answers are the source of truth
 *  (as Phase 3): they replace whatever the last draft held. A late
 *  draft after this finds status != in_progress and is dropped. A
 *  duplicate submit (already awaiting_review) acks without
 *  re-applying. */
export async function applySubmit(store: SessionStore, input: SubmitInput): Promise<SubmitResult> {
  const sub = await store.getSubmission(input.submissionId);
  if (!sub || sub.studentId !== input.studentId) throw notFound();
  if (sub.status !== "in_progress") return { submitted: false };
  const answers = validAnswers(input.answers, input.marks);
  await store.transaction(async () => {
    await store.upsertAnswers(sub.id, answers);
    await store.putSubmission({
      ...sub,
      status: "awaiting_review",
      submittedAt: input.nowIso,
      draftSeq: Math.max(sub.draftSeq, input.seq),
      dirty: true,
      updatedAt: input.nowIso,
    });
  });
  return { submitted: true };
}

/** Live status for the poll. Ownership is enforced here (a guessed
 *  id belonging to another student reads as pending, never leaks).
 *  A persistently failed flush is visible even though the row exists
 *  — the Phase 3 gap (§6). `null` means "not in this DO" and the
 *  caller falls back to the D1 getTakeStatus. */
export async function getSessionStatus(
  store: SessionStore,
  input: { submissionId: string; studentId: string; assessmentId: string },
): Promise<TakeStatus | null> {
  const sub = await store.getSubmission(input.submissionId);
  if (!sub) return null;
  if (sub.studentId !== input.studentId || sub.assessmentId !== input.assessmentId)
    return { status: "pending" };
  if (sub.dirty && sub.flushAttempts >= TAKE_SESSION_FLUSH_MAX_ATTEMPTS && sub.flushError)
    return { status: "failed", reason: sub.flushError };
  if (sub.status === "in_progress") {
    return {
      status: "started",
      submissionId: sub.id,
      lastAppliedDraftSeq: sub.draftSeq,
      redirected: false,
    };
  }
  return { status: "submitted", submissionId: sub.id, lastAppliedDraftSeq: sub.draftSeq };
}

/** Read a D1 submission + its answers into the DO store (lazy
 *  hydration, DESIGN.md §4). Used when the DO does not know a
 *  submissionId — pre-DO rows and resumes after the cutover. The
 *  hydrated row is clean (D1 already holds it); later mutations
 *  mark it dirty. Returns null when D1 has no such row. */
export async function hydrateFromD1(
  db: D1Database,
  store: SessionStore,
  submissionId: string,
): Promise<DoSubmissionState | null> {
  const row = await db
    .prepare("SELECT * FROM submissions WHERE id = ?")
    .bind(submissionId)
    .first<SubmissionRow>();
  if (!row) return null;
  const answers = await db
    .prepare("SELECT question_id, response, max_marks, time_spent_seconds FROM answers WHERE submission_id = ?")
    .bind(submissionId)
    .all<{ question_id: string; response: string; max_marks: number; time_spent_seconds: number }>();
  const sub: DoSubmissionState = {
    id: row.id,
    assessmentId: row.assessment_id,
    studentId: row.student_id,
    status: row.status === "awaiting_review" ? "awaiting_review" : "in_progress",
    attemptNumber: row.attempt_number ?? 1,
    startedAt: row.started_at ?? new Date().toISOString(),
    submittedAt: row.submitted_at,
    expiresAt: row.expires_at,
    questionOrder: row.question_order ? (JSON.parse(row.question_order) as string[]) : [],
    totalPossible: row.total_possible ?? 0,
    draftSeq: row.draft_seq ?? 0,
    dirty: false,
    flushAttempts: 0,
    flushError: null,
    updatedAt: new Date().toISOString(),
  };
  await store.transaction(async () => {
    await store.putSubmission(sub);
    const stored = (answers.results ?? []).map((a) => ({
      questionId: a.question_id,
      response: a.response ?? "",
      maxMarks: a.max_marks ?? 0,
      timeSpentSeconds: a.time_spent_seconds ?? 0,
    }));
    if (stored.length > 0) await store.upsertAnswers(sub.id, stored);
  });
  return sub;
}

function toSubmissionRow(sub: DoSubmissionState): SubmissionRow {
  return {
    id: sub.id,
    assessment_id: sub.assessmentId,
    student_id: sub.studentId,
    status: sub.status,
    attempt_number: sub.attemptNumber,
    started_at: sub.startedAt,
    submitted_at: sub.submittedAt,
    expires_at: sub.expiresAt,
    question_order: JSON.stringify(sub.questionOrder),
    final_score: null,
    total_possible: sub.totalPossible,
    draft_seq: sub.draftSeq,
  };
}

/** Flush one dirty submission to D1, reusing the existing D1
 *  functions (no new D1-write code). Order matters: the row must
 *  exist before its answers (insertSubmission is idempotent), the
 *  answers apply on the D1 row, the D1 draft_seq is then set to the
 *  DO's seq, and a submitted row flips + audits only when D1 still
 *  shows it in_progress (so a duplicate flush never double-audits).
 *  Returns ok:false (and records a failure at the threshold) instead
 *  of throwing, so one poison submission cannot block the batch. */
export async function flushOne(
  db: D1Database,
  store: SessionStore,
  sub: DoSubmissionState,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await retryD1Overload(async () => {
      await insertSubmission(db, {
        id: sub.id,
        assessmentId: sub.assessmentId,
        studentId: sub.studentId,
        attemptNumber: sub.attemptNumber,
        totalPossible: sub.totalPossible,
        expiresAt: sub.expiresAt,
        questionOrder: sub.questionOrder,
        nowIso: sub.startedAt,
      });
      const d1row = await db
        .prepare("SELECT * FROM submissions WHERE id = ?")
        .bind(sub.id)
        .first<SubmissionRow>();
      if (!d1row) throw new Error("TAKE_FLUSH_NO_ROW");
      const answers = await store.getAnswers(sub.id);
      const inputs: DraftAnswerInput[] = answers.map((a) => ({
        question_id: a.questionId,
        response: a.response,
        time_spent_seconds: a.timeSpentSeconds,
      }));
      await applyDraftAnswers(db, d1row, inputs, null);
      await db
        .prepare("UPDATE submissions SET draft_seq = ? WHERE id = ?")
        .bind(sub.draftSeq, sub.id)
        .run();
      if (sub.status === "awaiting_review") {
        const current = await db
          .prepare("SELECT * FROM submissions WHERE id = ?")
          .bind(sub.id)
          .first<SubmissionRow>();
        if (current && current.status === "in_progress") {
          await markSubmitted(db, current, sub.submittedAt ?? new Date().toISOString());
        }
      }
    });
    await store.markClean(sub.id);
    return { ok: true };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    const attempts = await store.bumpFlushAttempt(sub.id, reason);
    if (attempts >= TAKE_SESSION_FLUSH_MAX_ATTEMPTS) {
      try {
        await recordTakeFailure(db, {
          studentId: sub.studentId,
          submissionId: sub.id,
          assessmentId: sub.assessmentId,
          messageType: "flush",
          reason,
          attempts,
        });
      } catch {
        // The record is visibility only; the row stays dirty and the
        // next alarm retries. Never let the record block the flush.
      }
    }
    return { ok: false, reason };
  }
}

/** Flush up to `limit` dirty submissions (oldest first). Returns
 *  whether more dirty rows remain (the caller re-arms the alarm). */
export async function flushDirty(
  db: D1Database,
  store: SessionStore,
  limit: number = TAKE_SESSION_FLUSH_BATCH,
): Promise<{ flushed: number; failed: number; remaining: boolean }> {
  const dirty = await store.listDirty(limit);
  let flushed = 0;
  let failed = 0;
  for (const sub of dirty) {
    const result = await flushOne(db, store, sub);
    if (result.ok) flushed += 1;
    else failed += 1;
  }
  const remaining = (await store.listDirty(1)).length > 0;
  return { flushed, failed, remaining };
}
