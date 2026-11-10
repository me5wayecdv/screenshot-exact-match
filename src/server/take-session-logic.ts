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
import { canTakeAssessment } from "@/server/d1-take-gate";
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
  /** The student's current in-progress attempt for this exam, if any
   *  (the resume target — the DO store is the authority, including
   *  rows seeded from D1). */
  getInProgressSubmission(
    studentId: string,
    assessmentId: string,
  ): Promise<DoSubmissionState | null>;
  /** How many attempts the student has used on this exam (DO rows
   *  only — the seed imports their pre-DO rows first, so the count
   *  is exact). */
  countSubmissions(studentId: string, assessmentId: string): Promise<number>;
}

/** Cached exam config (DESIGN-V2.md): what start validation needs,
 *  read from D1 once per TTL per exam instead of once per student. */
export type ExamConfig = {
  assessmentId: string;
  status: string;
  startsAt: string | null;
  dueAt: string | null;
  maxAttempts: number;
  durationMinutes: number | null;
  totalPossible: number;
  loadedAt: number; // ms epoch
};

/** The config cache surface. The production implementation is the
 *  DO SQLite adapter (take-session.ts); tests use a Map. Only
 *  POSITIVE enrollment results are stored: a missing row means
 *  "check D1", never "denied", so a late approval is always picked
 *  up by the fallback. */
export interface ExamConfigStore {
  getConfig(): Promise<ExamConfig | null>;
  setConfig(
    config: ExamConfig,
    marks: Record<string, number>,
    enrolledStudentIds: string[],
  ): Promise<void>;
  getMarks(): Promise<Record<string, number>>;
  getEnrolledCheckedAt(studentId: string): Promise<number | null>;
  setEnrolled(studentId: string, checkedAt: number): Promise<void>;
  isStudentSeeded(studentId: string): Promise<boolean>;
  setStudentSeeded(studentId: string, seededAt: number): Promise<void>;
}

/** How long a cached config / enrolled row is trusted (DESIGN-V2.md).
 *  A synchronized burst lasts seconds, so the TTL is never hit
 *  mid-burst; it only bounds staleness (unpublish / window change /
 *  membership removal all take effect within this). */
export const TAKE_SESSION_CACHE_TTL_MS = 60_000;

/** Flush is recorded as a failure after this many failed cycles —
 *  the same visibility the queue's DLQ gave (DESIGN.md §5). */
export const TAKE_SESSION_FLUSH_MAX_ATTEMPTS = 3;

/** How many dirty submissions one alarm run flushes (oldest first).
 *  Small on purpose: a flush is several D1 statements, and the alarm
 *  re-arms while dirty rows remain. */
export const TAKE_SESSION_FLUSH_BATCH = 20;

/* ------------------------------------------- V2: DO-side config cache */

/** Read the exam config + question marks + enrolled set from D1
 *  (DESIGN-V2.md). Five reads, once per TTL per exam — the first
 *  student pays them, the rest of the burst reads the cache. The
 *  enrolled set is computed in JS from three small id lists (no
 *  correlated subqueries). Throws TAKE_NOT_FOUND when the exam does
 *  not exist. */
export async function loadExamConfig(
  db: D1Database,
  assessmentId: string,
  nowMs: number,
): Promise<{
  config: ExamConfig;
  marks: Record<string, number>;
  enrolled: string[];
}> {
  const assessment = await db
    .prepare(
      "SELECT status, starts_at, due_at, max_attempts, duration_minutes " +
        "FROM assessments WHERE id = ?",
    )
    .bind(assessmentId)
    .first<{
      status: string;
      starts_at: string | null;
      due_at: string | null;
      max_attempts: number | null;
      duration_minutes: number | null;
    }>();
  if (!assessment) throw new Error("TAKE_NOT_FOUND");
  const questions = await db
    .prepare("SELECT id, marks FROM questions WHERE assessment_id = ?")
    .bind(assessmentId)
    .all<{ id: string; marks: number }>();
  const marks: Record<string, number> = {};
  let totalPossible = 0;
  for (const q of questions.results ?? []) {
    marks[q.id] = q.marks;
    totalPossible += q.marks;
  }
  const assignments = await db
    .prepare("SELECT student_id FROM assessment_assignments WHERE assessment_id = ?")
    .bind(assessmentId)
    .all<{ student_id: string }>();
  const assigned = (assignments.results ?? []).map((r) => r.student_id);
  const links = await db
    .prepare("SELECT group_id FROM group_exams WHERE assessment_id = ?")
    .bind(assessmentId)
    .all<{ group_id: string }>();
  const groupIds = (links.results ?? []).map((r) => r.group_id);
  let enrolled = assigned;
  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => "?").join(", ");
    const members = await db
      .prepare(
        `SELECT student_id FROM group_members WHERE group_id IN (${placeholders}) ` +
          "AND status = 'approved'",
      )
      .bind(...groupIds)
      .all<{ student_id: string }>();
    const memberSet = new Set((members.results ?? []).map((r) => r.student_id));
    enrolled = assigned.filter((id) => memberSet.has(id));
  }
  return {
    config: {
      assessmentId,
      status: assessment.status,
      startsAt: assessment.starts_at ?? null,
      dueAt: assessment.due_at ?? null,
      maxAttempts: assessment.max_attempts ?? 1,
      durationMinutes: assessment.duration_minutes ?? null,
      totalPossible,
      loadedAt: nowMs,
    },
    marks,
    enrolled,
  };
}

/** Import a student's pre-DO submissions for this exam into the DO
 *  store (lightweight rows, no answers — the flush merges answers
 *  onto the D1 row, and the take page reads answers from D1). Runs
 *  once per student; the marker makes later starts free. Without
 *  this, the attempt count would miss pre-cutover history and a
 *  student could exceed max_attempts. */
export async function seedStudentSubmissions(
  db: D1Database,
  store: SessionStore,
  configStore: ExamConfigStore,
  studentId: string,
  assessmentId: string,
): Promise<void> {
  if (await configStore.isStudentSeeded(studentId)) return;
  const rows = await db
    .prepare("SELECT * FROM submissions WHERE assessment_id = ? AND student_id = ?")
    .bind(assessmentId, studentId)
    .all<SubmissionRow>();
  await store.transaction(async () => {
    for (const row of rows.results ?? []) {
      await store.putSubmission({
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
      });
    }
    await configStore.setStudentSeeded(studentId, Date.now());
  });
}

/** Start validation, inside the DO (DESIGN-V2.md) — the replacement
 *  for the Worker's resolveStart. Reads D1 only on cache misses: the
 *  config load (once per TTL per exam), the full gate fallback (a
 *  student missing from the cached enrolled set — e.g. a late
 *  approval), and the one-time student seed. A steady-state start
 *  costs ZERO D1 reads. Throws the same TAKE_* errors as
 *  resolveStart. Returns the existing in-progress id for a resume,
 *  otherwise the values applyStart needs. */
export async function validateStart(
  store: SessionStore,
  configStore: ExamConfigStore,
  db: D1Database,
  input: { studentId: string; assessmentId: string; nowIso: string },
): Promise<
  | { existingId: string }
  | { attemptNumber: number; totalPossible: number; expiresAt: string | null }
> {
  const nowMs = Date.parse(input.nowIso);
  let config = await configStore.getConfig();
  if (
    !config ||
    config.assessmentId !== input.assessmentId ||
    nowMs - config.loadedAt > TAKE_SESSION_CACHE_TTL_MS
  ) {
    const loaded = await loadExamConfig(db, input.assessmentId, nowMs);
    await configStore.setConfig(loaded.config, loaded.marks, loaded.enrolled);
    config = loaded.config;
  }
  if (config.status !== "published") throw new Error("TAKE_NOT_PUBLISHED");
  if (config.startsAt && config.startsAt > input.nowIso) throw new Error("TAKE_NOT_STARTED");
  if (config.dueAt && config.dueAt <= input.nowIso) throw new Error("TAKE_WINDOW_CLOSED");
  const checkedAt = await configStore.getEnrolledCheckedAt(input.studentId);
  if (checkedAt === null || nowMs - checkedAt > TAKE_SESSION_CACHE_TTL_MS) {
    // Not in the cached enrolled set (or stale): the full D1 gate is
    // the fallback, so a late approval is always picked up. Denials
    // are never cached.
    const gate = await canTakeAssessment(db, input.studentId, input.assessmentId, input.nowIso);
    if (!gate.allowed) throw new Error(`TAKE_${gate.reason}`);
    await configStore.setEnrolled(input.studentId, nowMs);
  }
  await seedStudentSubmissions(db, store, configStore, input.studentId, input.assessmentId);
  const existing = await store.getInProgressSubmission(input.studentId, input.assessmentId);
  if (existing) return { existingId: existing.id };
  const used = await store.countSubmissions(input.studentId, input.assessmentId);
  if (used >= Math.max(1, config.maxAttempts)) throw new Error("TAKE_NO_ATTEMPTS_LEFT");
  const expiresAt =
    config.durationMinutes != null
      ? new Date(nowMs + config.durationMinutes * 60_000).toISOString()
      : null;
  return { attemptNumber: used + 1, totalPossible: config.totalPossible, expiresAt };
}

/** Question marks for draft/submit, from the cache (DESIGN-V2.md).
 *  Loads the config from D1 only when the cache is missing or stale;
 *  `db` may be null when the cache is warm (the DO always has the
 *  binding in production — null only means "cannot load"). */
export async function getCachedMarks(
  configStore: ExamConfigStore,
  db: D1Database | null,
  assessmentId: string,
  nowMs: number,
): Promise<Record<string, number>> {
  const config = await configStore.getConfig();
  if (
    config &&
    config.assessmentId === assessmentId &&
    nowMs - config.loadedAt <= TAKE_SESSION_CACHE_TTL_MS
  ) {
    return configStore.getMarks();
  }
  if (!db) throw new Error("TakeSession: D1 binding unavailable — cannot load exam config");
  const loaded = await loadExamConfig(db, assessmentId, nowMs);
  await configStore.setConfig(loaded.config, loaded.marks, loaded.enrolled);
  return loaded.marks;
}

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
