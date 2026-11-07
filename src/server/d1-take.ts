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
type SubmissionRow = {
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
};
type QuestionRow = {
  id: string;
  prompt: string;
  type: string;
  options: string;
  marks: number;
  position: number;
};

function parseOptions(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseOrder(raw: string | null): string[] | null {
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

/* ------------------------------------------------------------- attempts */

async function startAttemptOnce(
  db: D1Database,
  studentId: string,
  assessmentId: string,
  questionOrder: string[],
  nowIso: string = new Date().toISOString(),
): Promise<{ submissionId: string }> {
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
  if (existing) return { submissionId: existing.id };
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
  const id = crypto.randomUUID();
  const started = new Date(nowIso);
  const expiresAt =
    assessment.duration_minutes != null
      ? new Date(started.getTime() + assessment.duration_minutes * 60_000).toISOString()
      : null;
  await db
    .prepare(
      "INSERT INTO submissions (id, assessment_id, student_id, status, attempt_number, started_at, " +
        "submitted_at, expires_at, question_order, total_possible) " +
        "VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      assessmentId,
      studentId,
      used + 1,
      nowIso,
      nowIso,
      expiresAt,
      JSON.stringify(questionOrder.slice(0, 500)),
      totalRow?.total ?? 0,
    )
    .run();
  return { submissionId: id };
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

async function saveDraftOnce(
  db: D1Database,
  studentId: string,
  submissionId: string,
  answers: DraftAnswerInput[],
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  const submission = await db
    .prepare("SELECT * FROM submissions WHERE id = ?")
    .bind(submissionId)
    .first<SubmissionRow>();
  if (!submission || submission.student_id !== studentId) return false;
  if (submission.status !== "in_progress") return false;
  const assessment = await db
    .prepare("SELECT due_at FROM assessments WHERE id = ?")
    .bind(submission.assessment_id)
    .first<{ due_at: string | null }>();
  // Edits freeze at expiry and at the window end (old save_draft rule).
  if (submission.expires_at && nowIso > submission.expires_at) return false;
  if (assessment?.due_at && nowIso > assessment.due_at) return false;
  const requested = answers.slice(0, 500);
  const byQuestion = new Map(requested.map((answer) => [answer.question_id, answer]));
  const questionIds = [...byQuestion.keys()];
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
      .bind(submissionId, submission.assessment_id, ...questionIds)
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
              submissionId,
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
  // Activity feed: exam submitted (label = exam title, never answers).
  const exam = await db
    .prepare("SELECT title FROM assessments WHERE id = ?")
    .bind(submission.assessment_id)
    .first<{ title: string }>();
  const statusWrite = db
    .prepare("UPDATE submissions SET status = 'awaiting_review', submitted_at = ? WHERE id = ?")
    .bind(nowIso, submissionId);
  const auditWrite = db
    .prepare("INSERT INTO audit_log (actor_id, action, entity_id, details) VALUES (?, ?, ?, ?)")
    .bind(
      studentId,
      "exam_submitted",
      submissionId,
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
    const { session, db } = ctx(context);
    requireStudent(session);
    return getTakeData(db, session.userId, data.assessmentId);
  });

export const startAttemptD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string; questionOrder: string[] })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireStudent(session);
    return startAttempt(db, session.userId, data.assessmentId, data.questionOrder);
  });

export const saveDraftD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { submissionId: string; answers: DraftAnswerInput[] })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireStudent(session);
    return { ok: await saveDraft(db, session.userId, data.submissionId, data.answers) };
  });

export const submitAttemptD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { submissionId: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireStudent(session);
    return { ok: await submitAttempt(db, session.userId, data.submissionId) };
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
