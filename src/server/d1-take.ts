/**
 * D1 server functions for the student take page (assessments/take/$id).
 *
 * GATE FIRST — the take page MUST call canTakeAssessment (frozen,
 * src/server/d1-take-gate.ts) before loading any question or answer.
 * getTakeData enforces exactly that, with two §6-preserving
 * exceptions that the gate itself documents:
 * - A started attempt is handled by the attempt logic, not the gate:
 *   when the student already has an in_progress draft, the draft
 *   loads even if the window has since closed (edits freeze
 *   server-side in saveDraft; submit stays allowed so a slow network
 *   cannot destroy frozen answers).
 * - A submitted attempt's history loads even after the window
 *   closes (history is not a new start).
 * Every OTHER gate failure (not found, not published, not assigned,
 * not a group member) returns { allowed: false } and issues NO
 * question, answer, or submission query at all.
 *
 * STUDENT DATA RULES (D1 has no RLS):
 * - Questions are selected WITHOUT question_keys — the word
 *   question_keys appears nowhere in a student query in this file.
 * - Answers returned are the student's OWN rows only, and scores /
 *   feedback are stripped everywhere except a released attempt's
 *   submission-level final_score/total_possible (the per-answer
 *   scores stay teacher-only until release, exactly as the old
 *   own_submission_responses rule: response text is the student's
 *   own, scores are not).
 * - attempt = latest: submissions are ordered by attempt_number and
 *   the page's history view uses the latest submitted attempt.
 * - Integrity signals (tab switches, per-question time, shuffle
 *   order) are recorded, never blocking or accusing. The recorder
 *   hook itself (useIntegrityRecorder) is a separate workstream and
 *   still writes via Supabase; recordIntegrityEventD1 here is the
 *   D1 path for the resume event the take page itself inserts.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";
import { getTakeSessions } from "@/server/d1";
import { requireCloudflareAuth } from "@/server/d1-session";
import { canTakeAssessment } from "@/server/d1-take-gate";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { effectiveRole } from "@/server/d1-assessments";
import { retryD1Overload } from "@/server/d1-retry";

export type TakeAssessment = {
  id: string;
  title: string;
  instructions: string;
  status: string;
  starts_at: string | null;
  due_at: string | null;
  max_attempts: number;
  duration_minutes: number | null;
};

export type TakeQuestion = {
  id: string;
  prompt: string;
  type: string;
  options: string[];
  marks: number;
  position: number;
};

export type TakeSubmission = {
  id: string;
  assessment_id: string;
  student_id: string;
  status: string;
  attempt_number: number;
  started_at: string | null;
  submitted_at: string | null;
  expires_at: string | null;
  question_order: string[] | null;
  final_score: number | null;
  total_possible: number | null;
  // Phase 3: highest draft seq the consumer has applied to this
  // submission. The client seeds its draft counter from this value so
  // a page reload never re-uses a stale low number (an older seq would
  // be skipped as already-applied and the new edits would never save).
  draft_seq: number;
};

export type TakeAnswer = { question_id: string; response: string };

export type TakeGateReason =
  | "NOT_FOUND"
  | "NOT_PUBLISHED"
  | "NOT_STARTED"
  | "WINDOW_CLOSED"
  | "NOT_ASSIGNED"
  | "NOT_GROUP_MEMBER";

export type TakeData =
  | { allowed: false; reason: TakeGateReason }
  | {
      allowed: true;
      assessment: TakeAssessment;
      questions: TakeQuestion[];
      submissions: TakeSubmission[];
      answersBySubmission: Record<string, TakeAnswer[]>;
    };

type AssessmentRow = TakeAssessment & { created_at?: string };
export type SubmissionRow = {
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
  total_possible: number | null;
  draft_seq: number | null;
};
type QuestionRow = {
  id: string;
  prompt: string;
  type: string;
  options: string;
  marks: number;
  position: number;
};

export function parseOptions(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function parseOrder(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

function toSubmission(row: SubmissionRow): TakeSubmission {
  return {
    id: row.id,
    assessment_id: row.assessment_id,
    student_id: row.student_id,
    status: row.status,
    attempt_number: row.attempt_number,
    started_at: row.started_at,
    submitted_at: row.submitted_at,
    expires_at: row.expires_at,
    question_order: parseOrder(row.question_order),
    final_score: row.final_score,
    total_possible: row.total_possible,
    draft_seq: row.draft_seq ?? 0,
  };
}

async function loadTakeBody(
  db: D1Database,
  studentId: string,
  assessmentId: string,
  assessment: AssessmentRow,
): Promise<Extract<TakeData, { allowed: true }>> {
  // Questions ONLY — never question_keys (see header).
  const questionsRes = await db
    .prepare(
      "SELECT id, prompt, type, options, marks, position FROM questions " +
        "WHERE assessment_id = ? ORDER BY position",
    )
    .bind(assessmentId)
    .all<QuestionRow>();
  const submissionsRes = await db
    .prepare(
      "SELECT * FROM submissions WHERE assessment_id = ? AND student_id = ? ORDER BY attempt_number",
    )
    .bind(assessmentId, studentId)
    .all<SubmissionRow>();
  const submissions = (submissionsRes.results ?? []).map(toSubmission);
  const answersBySubmission: Record<string, TakeAnswer[]> = {};
  if (submissions.length > 0) {
    const placeholders = submissions.map(() => "?").join(", ");
    const answersRes = await db
      .prepare(
        `SELECT submission_id, question_id, response FROM answers WHERE submission_id IN (${placeholders})`,
      )
      .bind(...submissions.map((s) => s.id))
      .all<{ submission_id: string; question_id: string; response: string }>();
    // Response text only: scores/feedback are never selected for a
    // student, so they cannot leak through this payload in any status.
    for (const row of answersRes.results ?? []) {
      (answersBySubmission[row.submission_id] ??= []).push({
        question_id: row.question_id,
        response: row.response,
      });
    }
  }
  return {
    allowed: true,
    assessment: {
      id: assessment.id,
      title: assessment.title,
      instructions: assessment.instructions,
      status: assessment.status,
      starts_at: assessment.starts_at,
      due_at: assessment.due_at,
      max_attempts: assessment.max_attempts,
      duration_minutes: assessment.duration_minutes,
    },
    questions: (questionsRes.results ?? []).map((q) => ({
      id: q.id,
      prompt: q.prompt,
      type: q.type,
      options: parseOptions(q.options),
      marks: q.marks,
      position: q.position,
    })),
    submissions,
    answersBySubmission,
  };
}

export async function getTakeData(
  db: D1Database,
  studentId: string,
  assessmentId: string,
  nowIso: string = new Date().toISOString(),
): Promise<TakeData> {
  const gate = await canTakeAssessment(db, studentId, assessmentId, nowIso);
  if (gate.allowed) {
    const assessment = await db
      .prepare("SELECT * FROM assessments WHERE id = ?")
      .bind(assessmentId)
      .first<AssessmentRow>();
    if (!assessment) return { allowed: false, reason: "NOT_FOUND" };
    return loadTakeBody(db, studentId, assessmentId, assessment);
  }
  // Gate failed. Only a window failure may still load an existing
  // attempt (draft resume / submitted history — see header); every
  // other failure loads nothing.
  if (gate.reason !== "NOT_STARTED" && gate.reason !== "WINDOW_CLOSED") {
    return { allowed: false, reason: gate.reason };
  }
  const assessment = await db
    .prepare("SELECT * FROM assessments WHERE id = ?")
    .bind(assessmentId)
    .first<AssessmentRow>();
  if (!assessment || assessment.status !== "published") {
    return { allowed: false, reason: "NOT_PUBLISHED" };
  }
  const own = await db
    .prepare(
      "SELECT * FROM submissions WHERE assessment_id = ? AND student_id = ? " +
        "ORDER BY attempt_number",
    )
    .bind(assessmentId, studentId)
    .all<SubmissionRow>();
  const rows = own.results ?? [];
  const hasDraft = rows.some((s) => s.status === "in_progress");
  const hasSubmitted = rows.some((s) => s.status !== "in_progress");
  if (!hasDraft && !hasSubmitted) return { allowed: false, reason: gate.reason };
  return loadTakeBody(db, studentId, assessmentId, assessment);
}

/* ------------------------------------------------- Phase 3: queue types */

/** Take-write queue messages (v1). `submissionId` is a client-generated
 *  UUID that becomes `submissions.id`, so the client can poll for it
 *  before any write lands. `seq` is monotonic per submission (client
 *  counter, seeded from the server's `draft_seq`); `submit` carries the
 *  FULL final answers and is the source of truth — drafts are progress
 *  insurance, so draft/submit ordering cannot corrupt a grade. */
/* ------------------------------------------- Phase 4: DO RPC helper */

/** Call one TakeSession DO method (POST /start, /draft, /submit,
 *  /status — DESIGN.md §3). The stub is the exam's object
 *  (`idFromName(assessmentId)`), so every student of one exam hits
 *  the same object. A TAKE_* error from the DO is re-thrown as-is
 *  (the client already translates it); any other failure is a
 *  plain error — the producer must never silently fall back to a
 *  direct D1 write. */
export async function callTakeSession<T>(
  assessmentId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const sessions = await getTakeSessions();
  const stub = sessions.get(sessions.idFromName(assessmentId));
  const response = await stub.fetch(
    new Request(`https://take-session${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, ...body }),
    }),
  );
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? "TAKE_SESSION_ERROR");
  }
  return payload as T;
}

/** Append-only take-write failure record (admin-visible via
 *  listTakeWriteFailuresD1). Never answers, never scores, never AI
 *  feedback — ids + reason only. Moved here from take-queue.ts
 *  (Phase 4): the DO flush records here too, so the failure store
 *  outlives the queue consumer. */
export type TakeFailureInput = {
  studentId: string;
  submissionId: string | null;
  assessmentId: string | null;
  messageType: string;
  reason: string;
  attempts: number;
};

export async function recordTakeFailure(db: D1Database, input: TakeFailureInput): Promise<void> {
  await db
    .prepare(
      "INSERT INTO take_write_failures (id, student_id, submission_id, assessment_id, " +
        "message_type, reason, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      input.studentId,
      input.submissionId,
      input.assessmentId,
      input.messageType,
      input.reason,
      input.attempts,
      new Date().toISOString(),
    )
    .run();
}

/* ------------------------------------------------------------- attempts */

/** Read-only start validation, shared by the producer (pre-DO
 *  check, so a gated-out student gets an immediate error instead of
 *  a DO-side failure) and the DO flush (re-validation at apply time,
 *  in case the window closed between the call and the flush).
 *  Throws the same TAKE_* errors as the old synchronous start. */
export async function resolveStart(
  db: D1Database,
  studentId: string,
  assessmentId: string,
  nowIso: string,
): Promise<{
  assessment: AssessmentRow;
  existingId: string | null;
  attemptNumber: number;
  totalPossible: number;
  expiresAt: string | null;
}> {
  // The gate (including the group check) is the authority for a NEW
  // start; a draft resume is idempotent below, not a new start.
  const gate = await canTakeAssessment(db, studentId, assessmentId, nowIso);
  if (!gate.allowed) throw new Error(`TAKE_${gate.reason}`);
  const assessment = await db
    .prepare("SELECT * FROM assessments WHERE id = ?")
    .bind(assessmentId)
    .first<AssessmentRow>();
  if (!assessment) throw new Error("TAKE_NOT_FOUND");
  const existing = await db
    .prepare(
      "SELECT id FROM submissions WHERE assessment_id = ? AND student_id = ? AND status = 'in_progress' " +
        "ORDER BY attempt_number DESC LIMIT 1",
    )
    .bind(assessmentId, studentId)
    .first<{ id: string }>();
  if (existing) {
    return {
      assessment,
      existingId: existing.id,
      attemptNumber: 0,
      totalPossible: 0,
      expiresAt: null,
    };
  }
  const usedRow = await db
    .prepare("SELECT COUNT(*) AS n FROM submissions WHERE assessment_id = ? AND student_id = ?")
    .bind(assessmentId, studentId)
    .first<{ n: number }>();
  const used = usedRow?.n ?? 0;
  if (used >= Math.max(1, assessment.max_attempts)) throw new Error("TAKE_NO_ATTEMPTS_LEFT");
  const totalRow = await db
    .prepare("SELECT COALESCE(SUM(marks), 0) AS total FROM questions WHERE assessment_id = ?")
    .bind(assessmentId)
    .first<{ total: number }>();
  const started = new Date(nowIso);
  const expiresAt =
    assessment.duration_minutes != null
      ? new Date(started.getTime() + assessment.duration_minutes * 60_000).toISOString()
      : null;
  return {
    assessment,
    existingId: null,
    attemptNumber: used + 1,
    totalPossible: totalRow?.total ?? 0,
    expiresAt,
  };
}

/** Insert a submission with a caller-provided id (Phase 3: the client's
 *  UUID, so the client can poll for it). Idempotent: a duplicate
 *  delivery (same id) returns the existing row, and a second start for
 *  the same student+assessment returns the existing in-progress row
 *  (the P4 one-in-progress partial index is the backstop — a conflict
 *  there is resolved to the existing row, never to a second draft). */
export async function insertSubmission(
  db: D1Database,
  input: {
    id: string;
    assessmentId: string;
    studentId: string;
    attemptNumber: number;
    totalPossible: number;
    expiresAt: string | null;
    questionOrder: string[];
    nowIso: string;
  },
): Promise<{ submissionId: string }> {
  const byId = await db
    .prepare("SELECT id FROM submissions WHERE id = ?")
    .bind(input.id)
    .first<{ id: string }>();
  if (byId) return { submissionId: byId.id };
  try {
    await db
      .prepare(
        "INSERT INTO submissions (id, assessment_id, student_id, status, attempt_number, started_at, " +
          "submitted_at, expires_at, question_order, total_possible) " +
          "VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.id,
        input.assessmentId,
        input.studentId,
        input.attemptNumber,
        input.nowIso,
        input.nowIso,
        input.expiresAt,
        JSON.stringify(input.questionOrder.slice(0, 500)),
        input.totalPossible,
      )
      .run();
    return { submissionId: input.id };
  } catch (error) {
    // PK or one-in-progress conflict under a race/duplicate delivery:
    // resolve to the row that won instead of failing the student.
    const message = error instanceof Error ? error.message : String(error);
    if (!/UNIQUE constraint failed/i.test(message)) throw error;
    const winner = await db
      .prepare(
        "SELECT id FROM submissions WHERE assessment_id = ? AND student_id = ? AND status = 'in_progress' " +
          "ORDER BY attempt_number DESC LIMIT 1",
      )
      .bind(input.assessmentId, input.studentId)
      .first<{ id: string }>();
    if (winner) return { submissionId: winner.id };
    const sameId = await db
      .prepare("SELECT id FROM submissions WHERE id = ?")
      .bind(input.id)
      .first<{ id: string }>();
    if (sameId) return { submissionId: sameId.id };
    throw error;
  }
}

async function startAttemptOnce(
  db: D1Database,
  studentId: string,
  assessmentId: string,
  questionOrder: string[],
  nowIso: string = new Date().toISOString(),
): Promise<{ submissionId: string }> {
  const resolved = await resolveStart(db, studentId, assessmentId, nowIso);
  if (resolved.existingId) return { submissionId: resolved.existingId };
  return insertSubmission(db, {
    id: crypto.randomUUID(),
    assessmentId,
    studentId,
    attemptNumber: resolved.attemptNumber,
    totalPossible: resolved.totalPossible,
    expiresAt: resolved.expiresAt,
    questionOrder,
    nowIso,
  });
}

export function startAttempt(
  db: D1Database,
  studentId: string,
  assessmentId: string,
  questionOrder: string[],
  nowIso?: string,
): Promise<{ submissionId: string }> {
  return retryD1Overload(() =>
    startAttemptOnce(db, studentId, assessmentId, questionOrder, nowIso),
  );
}

export type DraftAnswerInput = {
  question_id: string;
  response: string;
  time_spent_seconds: number;
};

/** Load + validate a draft target. Returns null when the submission
 *  does not exist or is not the caller's; `editable` is false when the
 *  draft is frozen (already submitted, expired, or past the window).
 *  The caller decides the failure mode: the sync path returns false,
 *  the queue consumer throws a permanent error (never retryable). */
export async function loadDraftTarget(
  db: D1Database,
  studentId: string,
  submissionId: string,
  nowIso: string,
): Promise<{ submission: SubmissionRow; editable: boolean } | null> {
  const submission = await db
    .prepare("SELECT * FROM submissions WHERE id = ?")
    .bind(submissionId)
    .first<SubmissionRow>();
  if (!submission || submission.student_id !== studentId) return null;
  if (submission.status !== "in_progress") return { submission, editable: false };
  const assessment = await db
    .prepare("SELECT due_at FROM assessments WHERE id = ?")
    .bind(submission.assessment_id)
    .first<{ due_at: string | null }>();
  // Edits freeze at expiry and at the window end (old save_draft rule).
  if (submission.expires_at && nowIso > submission.expires_at)
    return { submission, editable: false };
  if (assessment?.due_at && nowIso > assessment.due_at) return { submission, editable: false };
  return { submission, editable: true };
}

/** Apply draft answers (INSERT new / UPDATE existing, ownership-scoped
 *  by the assessment's questions; max_marks comes from the question,
 *  never the client).
 *
 *  Queue path (`seq !== null`): the seq claim is the single gate and
 *  every answer write is conditional on the claim still being current
 *  (`draft_seq = seq`). That closes the two holes a naive guard has:
 *  (1) a stale redelivery must not overwrite a newer draft's answers —
 *  the pre-check (`seq <= draft_seq`) skips it before any write, and
 *  the conditional writes stop a concurrent newer batch from being
 *  clobbered; (2) a retry after a mid-write failure must not lose the
 *  answers — when `draft_seq == seq` the claim already landed, so the
 *  answers are compared with what is stored and only the missing or
 *  differing ones are re-applied. The newer seq always wins; a stale
 *  batch writes nothing. Returns whether the message applied.
 *
 *  Sync path (`seq === null`): the old unconditional behaviour —
 *  single-writer, no redelivery, no claim. */
export async function applyDraftAnswers(
  db: D1Database,
  submission: SubmissionRow,
  answers: DraftAnswerInput[],
  seq: number | null,
): Promise<{ applied: "applied" | "duplicate"; lastAppliedDraftSeq: number }> {
  const requested = answers.slice(0, 500);
  const byQuestion = new Map(requested.map((answer) => [answer.question_id, answer]));
  const questionIds = [...byQuestion.keys()];
  if (seq !== null) {
    return applyQueuedDraftAnswers(db, submission, byQuestion, questionIds, seq);
  }
  const writes: D1Statement[] = [];
  if (questionIds.length > 0) {
    // One ownership-scoped read replaces per-answer question + answer lookups.
    const placeholders = questionIds.map(() => "?").join(", ");
    const rows = await db
      .prepare(
        "SELECT q.id AS question_id, q.marks, a.id AS answer_id FROM questions q " +
          "LEFT JOIN answers a ON a.question_id = q.id AND a.submission_id = ? " +
          `WHERE q.assessment_id = ? AND q.id IN (${placeholders})`,
      )
      .bind(submission.id, submission.assessment_id, ...questionIds)
      .all<{ question_id: string; marks: number; answer_id: string | null }>();
    const validQuestions = new Map((rows.results ?? []).map((row) => [row.question_id, row]));
    for (const [questionId, answer] of byQuestion) {
      // max_marks comes from the assessment's question, never the client.
      const question = validQuestions.get(questionId);
      if (!question) continue;
      const time = Math.max(0, Math.round(answer.time_spent_seconds || 0));
      if (question.answer_id) {
        writes.push(
          db
            .prepare("UPDATE answers SET response = ?, time_spent_seconds = ? WHERE id = ?")
            .bind(answer.response ?? "", time, question.answer_id),
        );
      } else {
        writes.push(
          db
            .prepare(
              "INSERT INTO answers (id, submission_id, question_id, response, max_marks, review_status, time_spent_seconds) " +
                "VALUES (?, ?, ?, ?, ?, 'not_graded', ?)",
            )
            .bind(
              crypto.randomUUID(),
              submission.id,
              questionId,
              answer.response ?? "",
              question.marks,
              time,
            ),
        );
      }
    }
  }
  for (let offset = 0; offset < writes.length; offset += 50) {
    const batch = writes.slice(offset, offset + 50);
    if (db.batch) await db.batch(batch);
    else for (const statement of batch) await statement.run();
  }
  return { applied: "applied", lastAppliedDraftSeq: submission.draft_seq ?? 0 };
}

/** Queue-path draft apply: claim the seq, then write answers only
 *  while the claim is current. Two passes at most: the second read
 *  always resolves a concurrent claim to "duplicate" or "re-apply". */
async function applyQueuedDraftAnswers(
  db: D1Database,
  submission: SubmissionRow,
  byQuestion: Map<string, DraftAnswerInput>,
  questionIds: string[],
  seq: number,
): Promise<{ applied: "applied" | "duplicate"; lastAppliedDraftSeq: number }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await db
      .prepare("SELECT draft_seq FROM submissions WHERE id = ?")
      .bind(submission.id)
      .first<{ draft_seq: number }>();
    const draftSeq = current?.draft_seq ?? 0;
    if (seq < draftSeq) return { applied: "duplicate", lastAppliedDraftSeq: draftSeq };
    if (seq === draftSeq) {
      // The claim already landed for this seq — a previous attempt may
      // have died mid-write. Compare with what is stored and re-apply
      // only the answers that are missing or differ.
      const stored = await db
        .prepare("SELECT question_id, response FROM answers WHERE submission_id = ?")
        .bind(submission.id)
        .all<{ question_id: string; response: string }>();
      const storedByQuestion = new Map(
        (stored.results ?? []).map((row) => [row.question_id, row.response]),
      );
      const missing = [...byQuestion].filter(
        ([questionId, answer]) => storedByQuestion.get(questionId) !== (answer.response ?? ""),
      );
      if (missing.length === 0) return { applied: "duplicate", lastAppliedDraftSeq: seq };
      await writeQueuedDraftAnswers(db, submission, missing, seq);
      const after = await db
        .prepare("SELECT draft_seq FROM submissions WHERE id = ?")
        .bind(submission.id)
        .first<{ draft_seq: number }>();
      const afterSeq = after?.draft_seq ?? seq;
      return afterSeq > seq
        ? { applied: "duplicate", lastAppliedDraftSeq: afterSeq }
        : { applied: "applied", lastAppliedDraftSeq: seq };
    }
    // seq > draftSeq: claim it. The guarded update is the atomic gate —
    // if a concurrent newer draft claimed first, changes === 0 and
    // nothing is written; loop once and re-read.
    const guard = await db
      .prepare("UPDATE submissions SET draft_seq = ? WHERE id = ? AND draft_seq < ?")
      .bind(seq, submission.id, seq)
      .run();
    const changed =
      (guard as unknown as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
    if (changed === 0) continue;
    await writeQueuedDraftAnswers(db, submission, [...byQuestion], seq);
    return { applied: "applied", lastAppliedDraftSeq: seq };
  }
  const final = await db
    .prepare("SELECT draft_seq FROM submissions WHERE id = ?")
    .bind(submission.id)
    .first<{ draft_seq: number }>();
  return { applied: "duplicate", lastAppliedDraftSeq: final?.draft_seq ?? seq };
}

/** Write queued draft answers. Every write is conditional on the seq
 *  claim still being current (`draft_seq = seq`), so a concurrent
 *  newer batch can never be clobbered by a stale one. The INSERT uses
 *  a SELECT source so the condition can gate the insert itself; the
 *  ON CONFLICT clause keeps the upsert idempotent. */
async function writeQueuedDraftAnswers(
  db: D1Database,
  submission: SubmissionRow,
  entries: [string, DraftAnswerInput][],
  seq: number,
): Promise<void> {
  const questionIds = entries.map(([questionId]) => questionId);
  if (questionIds.length === 0) return;
  const placeholders = questionIds.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      "SELECT q.id AS question_id, q.marks, a.id AS answer_id FROM questions q " +
        "LEFT JOIN answers a ON a.question_id = q.id AND a.submission_id = ? " +
        `WHERE q.assessment_id = ? AND q.id IN (${placeholders})`,
    )
    .bind(submission.id, submission.assessment_id, ...questionIds)
    .all<{ question_id: string; marks: number; answer_id: string | null }>();
  const validQuestions = new Map((rows.results ?? []).map((row) => [row.question_id, row]));
  const writes: D1Statement[] = [];
  for (const [questionId, answer] of entries) {
    const question = validQuestions.get(questionId);
    if (!question) continue;
    const time = Math.max(0, Math.round(answer.time_spent_seconds || 0));
    if (question.answer_id) {
      writes.push(
        db
          .prepare(
            "UPDATE answers SET response = ?, time_spent_seconds = ? WHERE id = ? " +
              "AND (SELECT draft_seq FROM submissions WHERE id = ?) = ?",
          )
          .bind(answer.response ?? "", time, question.answer_id, submission.id, seq),
      );
    } else {
      writes.push(
        db
          .prepare(
            "INSERT INTO answers (id, submission_id, question_id, response, max_marks, review_status, time_spent_seconds) " +
              "SELECT ?, ?, ?, ?, ?, 'not_graded', ? WHERE (SELECT draft_seq FROM submissions WHERE id = ?) = ? " +
              "ON CONFLICT(submission_id, question_id) DO UPDATE SET response = excluded.response, time_spent_seconds = excluded.time_spent_seconds",
          )
          .bind(
            crypto.randomUUID(),
            submission.id,
            questionId,
            answer.response ?? "",
            question.marks,
            time,
            submission.id,
            seq,
          ),
      );
    }
  }
  for (let offset = 0; offset < writes.length; offset += 50) {
    const batch = writes.slice(offset, offset + 50);
    if (db.batch) await db.batch(batch);
    else for (const statement of batch) await statement.run();
  }
}

async function saveDraftOnce(
  db: D1Database,
  studentId: string,
  submissionId: string,
  answers: DraftAnswerInput[],
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  const target = await loadDraftTarget(db, studentId, submissionId, nowIso);
  if (!target || !target.editable) return false;
  await applyDraftAnswers(db, target.submission, answers, null);
  return true;
}

export function saveDraft(
  db: D1Database,
  studentId: string,
  submissionId: string,
  answers: DraftAnswerInput[],
  nowIso?: string,
): Promise<boolean> {
  return retryD1Overload(() => saveDraftOnce(db, studentId, submissionId, answers, nowIso));
}

/** Flip a validated in-progress submission to awaiting_review + write
 *  the exam-submitted audit row (label = exam title, never answers).
 *  The caller owns validation; the flip itself is idempotent-safe only
 *  through the caller's status check — a duplicate submit is caught
 *  there, never here. */
export async function markSubmitted(
  db: D1Database,
  submission: SubmissionRow,
  nowIso: string,
): Promise<void> {
  // Activity feed: exam submitted (label = exam title, never answers).
  const exam = await db
    .prepare("SELECT title FROM assessments WHERE id = ?")
    .bind(submission.assessment_id)
    .first<{ title: string }>();
  const statusWrite = db
    .prepare("UPDATE submissions SET status = 'awaiting_review', submitted_at = ? WHERE id = ?")
    .bind(nowIso, submission.id);
  const auditWrite = db
    .prepare("INSERT INTO audit_log (actor_id, action, entity_id, details) VALUES (?, ?, ?, ?)")
    .bind(
      submission.student_id,
      "exam_submitted",
      submission.id,
      JSON.stringify({
        assessment_id: submission.assessment_id,
        target_label: exam?.title ?? "",
      }),
    );
  if (db.batch) await db.batch([statusWrite, auditWrite]);
  else {
    await statusWrite.run();
    await auditWrite.run();
  }
}

async function submitAttemptOnce(
  db: D1Database,
  studentId: string,
  submissionId: string,
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  const submission = await db
    .prepare("SELECT * FROM submissions WHERE id = ?")
    .bind(submissionId)
    .first<SubmissionRow>();
  if (!submission || submission.student_id !== studentId) return false;
  if (submission.status !== "in_progress") return false;
  // Submit stays allowed after expiry/window end: edits are already
  // frozen by saveDraft, and rejecting here would destroy frozen work.
  await markSubmitted(db, submission, nowIso);
  return true;
}

export function submitAttempt(
  db: D1Database,
  studentId: string,
  submissionId: string,
  nowIso?: string,
): Promise<boolean> {
  return retryD1Overload(() => submitAttemptOnce(db, studentId, submissionId, nowIso));
}

const INTEGRITY_EVENTS = [
  "tab_hidden",
  "tab_visible",
  "window_blur",
  "window_focus",
  "session_interrupted",
] as const;

export async function recordIntegrityEvent(
  db: D1Database,
  studentId: string,
  submissionId: string,
  eventType: string,
  questionId: string | null,
): Promise<void> {
  if (!(INTEGRITY_EVENTS as readonly string[]).includes(eventType)) {
    throw new Error("INVALID_EVENT");
  }
  const submission = await db
    .prepare("SELECT assessment_id, student_id FROM submissions WHERE id = ?")
    .bind(submissionId)
    .first<{ assessment_id: string; student_id: string }>();
  if (!submission || submission.student_id !== studentId) throw new Error("NOT_FOUND");
  if (questionId) {
    const question = await db
      .prepare("SELECT id FROM questions WHERE id = ? AND assessment_id = ?")
      .bind(questionId, submission.assessment_id)
      .first<{ id: string }>();
    if (!question) throw new Error("NOT_FOUND");
  }
  await db
    .prepare(
      "INSERT INTO integrity_events (id, submission_id, question_id, event_type) VALUES (?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), submissionId, questionId, eventType)
    .run();
}

/* --------------------------------------------- Phase 3: take status */

/** Poll result for a queued take write. Only status + the applied
 *  draft marker — never scores, feedback, or ai_feedback (P6 holds on
 *  this endpoint exactly as on the old surfaces). */
export type TakeStatus =
  | { status: "pending" }
  | {
      status: "started";
      submissionId: string;
      lastAppliedDraftSeq: number;
      redirected: boolean;
    }
  | { status: "submitted"; submissionId: string; lastAppliedDraftSeq: number }
  | { status: "failed"; reason: string };

export async function getTakeStatus(
  db: D1Database,
  studentId: string,
  submissionId: string,
  assessmentId: string,
): Promise<TakeStatus> {
  const row = await db
    .prepare("SELECT * FROM submissions WHERE id = ?")
    .bind(submissionId)
    .first<SubmissionRow>();
  if (row) {
    // Never leak another student's row through a guessed id.
    if (row.student_id !== studentId) return { status: "pending" };
    if (row.status === "in_progress") {
      return {
        status: "started",
        submissionId: row.id,
        lastAppliedDraftSeq: row.draft_seq ?? 0,
        redirected: false,
      };
    }
    return {
      status: "submitted",
      submissionId: row.id,
      lastAppliedDraftSeq: row.draft_seq ?? 0,
    };
  }
  // No row: a recorded permanent failure for this submission id?
  const failure = await db
    .prepare(
      "SELECT reason FROM take_write_failures WHERE submission_id = ? " +
        "ORDER BY created_at DESC LIMIT 1",
    )
    .bind(submissionId)
    .first<{ reason: string }>();
  if (failure) return { status: "failed", reason: failure.reason };
  // No row, no failure: a racing second start may have resolved to an
  // existing in-progress submission — redirect the client to it.
  const existing = await db
    .prepare(
      "SELECT id, draft_seq FROM submissions WHERE assessment_id = ? AND student_id = ? " +
        "AND status = 'in_progress' ORDER BY attempt_number DESC LIMIT 1",
    )
    .bind(assessmentId, studentId)
    .first<{ id: string; draft_seq: number | null }>();
  if (existing) {
    return {
      status: "started",
      submissionId: existing.id,
      lastAppliedDraftSeq: existing.draft_seq ?? 0,
      redirected: true,
    };
  }
  return { status: "pending" };
}

/* ------------------------------------------------------- server wrappers */

function ctx(context: unknown): { session: AuthSession; db: D1Database } {
  return context as { session: AuthSession; db: D1Database };
}

function requireStudent(session: AuthSession): void {
  if (effectiveRole(session) !== "student") throw new Error("FORBIDDEN");
}

export const getTakeDataD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string })
  .handler(async ({ context, data }) => {
    // Phase 4 V3 (DESIGN-V3.md): the take page's payload is served
    // from the TakeSession DO (config + questions + submissions +
    // answers, all cached) — the Worker no longer pays 3 D1 reads
    // per student for it. The D1 getTakeData stays for tests and as
    // the reference implementation of the same contract.
    const { session } = ctx(context);
    requireStudent(session);
    return callTakeSession<TakeData>(data.assessmentId, "/data", {
      studentId: session.userId,
      assessmentId: data.assessmentId,
      nowIso: new Date().toISOString(),
    });
  });

// Phase 4 producers (V2): the DO validates + applies. The Worker is
// a thin pass-through — no D1 reads on the start path (the DO-side
// config cache holds the gate), and no per-draft/per-submit marks
// read (the DO caches the marks). Drafts/submits still pre-check the
// submission row in D1: it gives the Worker the assessmentId for DO
// routing and the ownership check, and those calls are spread over
// the exam, not synchronized. The client polls getTakeStatusD1 for
// the row (the poll reads the DO and resolves on the first poll).
// A resume returns the existing draft synchronously.
export const startAttemptD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) =>
      data as { assessmentId: string; questionOrder: string[]; submissionId: string },
  )
  .handler(async ({ context, data }) => {
    const { session } = ctx(context);
    requireStudent(session);
    return callTakeSession<{ queued: boolean; submissionId: string }>(
      data.assessmentId,
      "/start",
      {
        submissionId: data.submissionId,
        studentId: session.userId,
        assessmentId: data.assessmentId,
        questionOrder: data.questionOrder,
        nowIso: new Date().toISOString(),
      },
    );
  });

export const saveDraftD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) => data as { submissionId: string; answers: DraftAnswerInput[]; seq: number },
  )
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireStudent(session);
    const target = await retryD1Overload(() =>
      loadDraftTarget(db, session.userId, data.submissionId, new Date().toISOString()),
    );
    if (!target || !target.editable) return { ok: false, queued: false };
    const result = await callTakeSession<{ applied: string }>(
      target.submission.assessment_id,
      "/draft",
      {
        submissionId: data.submissionId,
        studentId: session.userId,
        answers: data.answers,
        seq: data.seq,
      },
    );
    if (result.applied === "not_editable") return { ok: false, queued: false };
    return { ok: true, queued: true };
  });

export const submitAttemptD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) => data as { submissionId: string; answers: DraftAnswerInput[]; seq: number },
  )
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireStudent(session);
    const submission = await retryD1Overload(() =>
      db
        .prepare("SELECT * FROM submissions WHERE id = ?")
        .bind(data.submissionId)
        .first<SubmissionRow>(),
    );
    if (!submission || submission.student_id !== session.userId)
      return { ok: false, queued: false };
    if (submission.status !== "in_progress") return { ok: false, queued: false };
    const result = await callTakeSession<{ submitted: boolean }>(
      submission.assessment_id,
      "/submit",
      {
        submissionId: data.submissionId,
        studentId: session.userId,
        answers: data.answers,
        seq: data.seq,
        nowIso: new Date().toISOString(),
      },
    );
    if (!result.submitted) return { ok: false, queued: false };
    return { ok: true, queued: true };
  });

export const getTakeStatusD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { submissionId: string; assessmentId: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireStudent(session);
    const status = await callTakeSession<TakeStatus>(data.assessmentId, "/status", {
      submissionId: data.submissionId,
      studentId: session.userId,
      assessmentId: data.assessmentId,
    });
    // The DO answers from live state; "pending" means it does not
    // know this submission, so fall back to the D1 status (pre-DO
    // rows, redirect-to-existing, failure lookup — unchanged).
    if (status.status !== "pending") return status;
    return getTakeStatus(db, session.userId, data.submissionId, data.assessmentId);
  });

export const recordIntegrityEventD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) =>
      data as { submissionId: string; eventType: string; questionId: string | null },
  )
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireStudent(session);
    await recordIntegrityEvent(
      db,
      session.userId,
      data.submissionId,
      data.eventType,
      data.questionId,
    );
    return { ok: true };
  });
