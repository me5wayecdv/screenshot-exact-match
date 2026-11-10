/**
 * Cloudflare Queues consumer for the take write path (Phase 3).
 *
 * Why a queue: the 2026-11-10 live load test proved the burst ceiling
 * is D1's single-writer write overload (150 students → 18.7%, 250 →
 * 0%, every failure a D1 overload on the write path). The queue is the
 * shock absorber: producers enqueue (durable accept, §d1-take.ts) and
 * this consumer drains at a throttled rate the D1 10s window can
 * absorb. A burst becomes delay, never loss.
 *
 * Delivery semantics (Cloudflare Queues: at-least-once, no ordering
 * guarantee, `message.attempts` counts deliveries):
 * - Every apply is idempotent by natural key (see DESIGN.md §4):
 *   start by submissionId (PK), draft by (submissionId, seq) against
 *   `submissions.draft_seq`, submit by submissionId + status check.
 * - Transient failures (D1 overload after the internal
 *   retryD1Overload) throw → the queue redelivers with backoff
 *   (`retry_delay: 10`, `max_retries: 5`) → DLQ after exhaustion.
 * - Permanent failures (gate closed, no attempts left, invalid
 *   target) NEVER retry: the consumer records a `take_write_failures`
 *   row and acks. Retrying them would only poison the DLQ.
 * - The consumer processes messages SEQUENTIALLY within a batch, so
 *   one student's messages in the same batch apply in order. Across
 *   batches the seq/status guards (not ordering) carry correctness.
 *
 * The consumer never grades: MCQ auto-scoring is lazy in the teacher
 * grading page (autoScoreFor, grading.tsx) — submit never graded
 * server-side, so there is no grading logic to move here.
 */

import type { D1Database } from "@/server/d1-auth-store";
import {
  applyDraftAnswers,
  insertSubmission,
  loadDraftTarget,
  markSubmitted,
  resolveStart,
  type SubmissionRow,
  type TakeQueueMessage,
} from "@/server/d1-take";
import { retryD1Overload } from "@/server/d1-retry";

/** Max deliveries configured for the queue (wrangler.jsonc
 *  `max_retries`). The consumer uses it to recognise its last chance
 *  and record the failure before the message goes to the DLQ. */
export const TAKE_QUEUE_MAX_RETRIES = 5;

/** Minimal structural types for a queue batch — no @cloudflare
 *  dependency, so this module stays unit-testable with plain fakes. */
export type TakeQueueMessageHandle<T> = {
  id: string;
  body: T;
  attempts: number;
  ack: () => void;
  retry: () => void;
};

export type TakeQueueBatch<T> = {
  messages: TakeQueueMessageHandle<T>[];
};

/** Error class for failures that must NEVER be retried (gate closed,
 *  no attempts left, invalid target). The consumer records them and
 *  acks instead of throwing. */
export class TakeQueuePermanentError extends Error {
  constructor(
    public readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "TakeQueuePermanentError";
  }
}

export type TakeFailureInput = {
  studentId: string;
  submissionId: string | null;
  assessmentId: string | null;
  messageType: string;
  reason: string;
  attempts: number;
};

/** Append-only failure record (admin-visible via listTakeWriteFailuresD1).
 *  Never answers, never scores, never AI feedback — ids + reason only. */
export async function recordTakeFailure(
  db: D1Database,
  input: TakeFailureInput,
): Promise<void> {
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

/** Best-effort variant for the final-attempt path: if the insert itself
 *  fails (D1 down), swallow it — the throw that follows still sends
 *  the message to the DLQ, which is the durability guarantee. */
async function recordTakeFailureBestEffort(
  db: D1Database,
  input: TakeFailureInput,
): Promise<void> {
  try {
    await recordTakeFailure(db, input);
  } catch {
    // The DLQ still captures the message; the record is visibility only.
  }
}

function permanent(reason: string, message?: string): TakeQueuePermanentError {
  return new TakeQueuePermanentError(reason, message);
}

async function applyStart(
  db: D1Database,
  msg: Extract<TakeQueueMessage, { type: "start" }>,
  nowIso: string,
): Promise<{ submissionId: string }> {
  // Gate failures are permanent: the window closed (or the student ran
  // out of attempts) between enqueue and processing — retrying would
  // only poison the DLQ. D1 overload errors are NOT TAKE_* codes, so
  // they stay transient and are retried by the caller.
  let resolved;
  try {
    resolved = await resolveStart(db, msg.studentId, msg.assessmentId, nowIso);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^TAKE_/.test(message)) throw permanent(message, message);
    throw error;
  }
  if (resolved.existingId) return { submissionId: resolved.existingId };
  return insertSubmission(db, {
    id: msg.submissionId,
    assessmentId: msg.assessmentId,
    studentId: msg.studentId,
    attemptNumber: resolved.attemptNumber,
    totalPossible: resolved.totalPossible,
    expiresAt: resolved.expiresAt,
    questionOrder: msg.questionOrder,
    nowIso,
  });
}

async function applyDraft(
  db: D1Database,
  msg: Extract<TakeQueueMessage, { type: "draft" }>,
  nowIso: string,
): Promise<{ applied: boolean }> {
  const target = await loadDraftTarget(db, msg.studentId, msg.submissionId, nowIso);
  if (!target) throw permanent("TAKE_NOT_FOUND", "Draft target not found or not owned.");
  if (!target.editable)
    throw permanent("TAKE_NOT_EDITABLE", "Draft is frozen or already submitted.");
  // The seq claim + conditional writes live inside applyDraftAnswers
  // (pre-check, claim, re-apply after a mid-write failure) — see its
  // doc comment in d1-take.ts.
  const result = await applyDraftAnswers(db, target.submission, msg.answers, msg.seq);
  return { applied: result.applied === "applied" };
}

async function applySubmit(
  db: D1Database,
  msg: Extract<TakeQueueMessage, { type: "submit" }>,
  nowIso: string,
): Promise<{ submitted: boolean }> {
  const submission = await db
    .prepare("SELECT * FROM submissions WHERE id = ?")
    .bind(msg.submissionId)
    .first<SubmissionRow>();
  if (!submission || submission.student_id !== msg.studentId)
    throw permanent("TAKE_NOT_FOUND", "Submit target not found or not owned.");
  if (submission.status !== "in_progress") return { submitted: false }; // duplicate delivery
  // The submit carries the FULL final answers and is the source of
  // truth: apply them unconditionally (a late draft finds status !=
  // in_progress and is dropped), then flip the status + audit.
  await applyDraftAnswers(db, submission, msg.answers, null);
  await markSubmitted(db, submission, nowIso);
  return { submitted: true };
}

/** Apply one message. Throws TakeQueuePermanentError for non-retryable
 *  failures; throws anything else (after the internal D1 retry) for
 *  transient failures, which the queue redelivers. */
export async function processTakeMessage(
  db: D1Database,
  message: TakeQueueMessage,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  switch (message.type) {
    case "start":
      await retryD1Overload(() => applyStart(db, message, nowIso));
      return;
    case "draft":
      await retryD1Overload(() => applyDraft(db, message, nowIso));
      return;
    case "submit":
      await retryD1Overload(() => applySubmit(db, message, nowIso));
      return;
  }
}

function failureInput(
  message: TakeQueueMessage,
  reason: string,
  attempts: number,
): TakeFailureInput {
  return {
    studentId: message.studentId,
    submissionId: message.submissionId,
    assessmentId: message.type === "start" ? message.assessmentId : null,
    messageType: message.type,
    reason,
    attempts,
  };
}

/** Queue entry point (exported as `queue` from src/worker-entry.ts).
 *  Sequential within a batch; per-message ack/retry — never throws
 *  for a single message, so one poison message cannot requeue the
 *  whole batch. Only a missing DB binding throws (nothing can be
 *  processed at all, so a whole-batch retry is correct). */
export async function handleTakeQueueBatch(
  batch: TakeQueueBatch<TakeQueueMessage>,
  env: { DB?: D1Database },
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  const db = env.DB;
  if (!db) throw new Error("TAKE_QUEUE_NO_DB: queue consumer has no D1 binding.");
  for (const msg of batch.messages) {
    try {
      await processTakeMessage(db, msg.body, nowIso);
      msg.ack();
    } catch (error) {
      if (error instanceof TakeQueuePermanentError) {
        await recordTakeFailureBestEffort(
          db,
          failureInput(msg.body, error.reason, msg.attempts),
        );
        msg.ack();
        continue;
      }
      // Transient (D1 overload after internal retries): on the last
      // delivery, record the failure best-effort, then retry so the
      // message moves to the DLQ instead of vanishing.
      if (msg.attempts >= TAKE_QUEUE_MAX_RETRIES) {
        const reason =
          error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        await recordTakeFailureBestEffort(
          db,
          failureInput(msg.body, `DLQ:${reason}`, msg.attempts),
        );
      }
      msg.retry();
    }
  }
}
