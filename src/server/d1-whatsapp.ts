/**
 * D1 WhatsApp send claims (Phase 2 port of Supabase
 * `claim_whatsapp_send` / `finish_whatsapp_send`).
 *
 * Old semantics (migration 20261031120000_backend_security_and_scale.sql),
 * preserved verbatim:
 * - A submission that already has a whatsapp_sends row with status
 *   'sent' can never be claimed again: the claim row is marked
 *   completed and claim returns false.
 * - Otherwise a claim row (submission_id PRIMARY KEY) is inserted, or
 *   an existing uncompleted claim is re-claimed ONLY if it is older
 *   than 15 minutes. A second claim inside the window changes 0 rows
 *   and returns false — the double-claim failure is the whole point.
 * - finish: only the holder of an uncompleted claim can finish it;
 *   it writes the whatsapp_sends audit row and either completes the
 *   claim (sent, or failed/skipped and not retryable) or deletes it
 *   (failed/skipped and retryable, so a later attempt can claim).
 *
 * WHATSAPP SENDING ITSELF STAYS OFF in the pilot: this module
 * contains no WhatsApp API call, no phone-number handling, and no
 * message sending — only the claim/audit bookkeeping, so the
 * idempotency story is ready when sending is switched on.
 *
 * Atomicity: claim is ONE conditional INSERT ... ON CONFLICT DO
 * UPDATE statement; its meta.changes (1 = claimed, 0 = already
 * claimed) is the answer. Finish runs its audit insert + claim
 * update/delete in a db.batch() so the two cannot half-apply.
 * Ownership: the caller must own the submission's assessment
 * (assessments.teacher_id = caller); a non-owner gets FORBIDDEN
 * and no claim row is touched.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";

export const WHATSAPP_RECLAIM_MINUTES = 15;

export class WhatsappClaimError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "NOT_FOUND" | "INVALID_SEND",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "WhatsappClaimError";
  }
}

type RunMeta = { meta?: { changes?: number } };

function runChanges(result: unknown): number {
  const meta = (result as RunMeta | null | undefined)?.meta;
  return typeof meta?.changes === "number" ? meta.changes : 0;
}

async function assertOwnsSubmission(
  db: D1Database,
  teacherId: string,
  submissionId: string,
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT a.teacher_id AS teacher_id FROM submissions s " +
        "JOIN assessments a ON a.id = s.assessment_id " +
        "WHERE s.id = ?",
    )
    .bind(submissionId)
    .first<{ teacher_id: string }>();
  if (!row) throw new WhatsappClaimError("NOT_FOUND", "Submission not found.");
  if (row.teacher_id !== teacherId) {
    throw new WhatsappClaimError("FORBIDDEN", "Submission belongs to another teacher.");
  }
}

/**
 * Claim a WhatsApp send for one submission. Returns true only when
 * this call acquired the claim. A second claim inside the 15-minute
 * window, or a claim for an already-sent submission, returns false.
 */
export async function claimWhatsappSend(
  db: D1Database,
  teacherId: string,
  submissionId: string,
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  await assertOwnsSubmission(db, teacherId, submissionId);
  const sent = await db
    .prepare("SELECT id FROM whatsapp_sends WHERE submission_id = ? AND status = 'sent' LIMIT 1")
    .bind(submissionId)
    .first<{ id: string }>();
  if (sent) {
    // Already sent: mark the claim completed (mirrors the old fn's
    // backfill branch) and refuse the claim.
    await db
      .prepare(
        "INSERT INTO whatsapp_send_claims (submission_id, claimed_at, completed) " +
          "VALUES (?, ?, 1) " +
          "ON CONFLICT(submission_id) DO UPDATE SET completed = 1",
      )
      .bind(submissionId, nowIso)
      .run();
    return false;
  }
  const cutoff = new Date(Date.parse(nowIso) - WHATSAPP_RECLAIM_MINUTES * 60_000).toISOString();
  const result = await db
    .prepare(
      "INSERT INTO whatsapp_send_claims (submission_id, claimed_at, completed) " +
        "VALUES (?, ?, 0) " +
        "ON CONFLICT(submission_id) DO UPDATE SET claimed_at = excluded.claimed_at " +
        "WHERE whatsapp_send_claims.completed = 0 AND whatsapp_send_claims.claimed_at < ?",
    )
    .bind(submissionId, nowIso, cutoff)
    .run();
  return runChanges(result) === 1;
}

export type WhatsappFinishInput = {
  status: "sent" | "failed" | "skipped";
  trigger: "manual" | "auto";
  messageId?: string | null;
  error?: string | null;
  retryable?: boolean;
};

/**
 * Finish a claimed send: writes the whatsapp_sends audit row and
 * completes (or, for a retryable failure, releases) the claim.
 * Returns false when there is no uncompleted claim to finish.
 */
export async function finishWhatsappSend(
  db: D1Database,
  teacherId: string,
  submissionId: string,
  input: WhatsappFinishInput,
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  await assertOwnsSubmission(db, teacherId, submissionId);
  if (!["sent", "failed", "skipped"].includes(input.status)) {
    throw new WhatsappClaimError("INVALID_SEND", "Invalid send status.");
  }
  if (!["manual", "auto"].includes(input.trigger)) {
    throw new WhatsappClaimError("INVALID_SEND", "Invalid send trigger.");
  }
  const claim = await db
    .prepare(
      "SELECT submission_id FROM whatsapp_send_claims " +
        "WHERE submission_id = ? AND completed = 0",
    )
    .bind(submissionId)
    .first<{ submission_id: string }>();
  if (!claim) return false;
  const audit = db
    .prepare(
      "INSERT INTO whatsapp_sends " +
        "(id, submission_id, trigger, status, message_id, error, sent_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      submissionId,
      input.trigger,
      input.status,
      input.messageId ?? null,
      input.error ? input.error.slice(0, 500) : null,
      nowIso,
    );
  const release =
    input.status === "sent" || !input.retryable
      ? db
          .prepare(
            "UPDATE whatsapp_send_claims SET completed = 1, claimed_at = ? " +
              "WHERE submission_id = ?",
          )
          .bind(nowIso, submissionId)
      : db.prepare("DELETE FROM whatsapp_send_claims WHERE submission_id = ?").bind(submissionId);
  if (db.batch) await db.batch([audit, release]);
  else {
    await audit.run();
    await release.run();
  }
  return true;
}

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

/**
 * Server wrapper: claim for the session teacher only. Sending itself
 * is OFF — this wrapper only acquires the claim; no message is sent.
 */
export const claimWhatsappSendD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { submissionId: string })
  .handler(async ({ data, context }): Promise<{ claimed: boolean }> => {
    const session = ctxSession(context);
    return { claimed: await claimWhatsappSend(ctxDb(context), session.userId, data.submissionId) };
  });
