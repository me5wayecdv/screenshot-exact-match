/**
 * D1 grade reviews (Phase 2 port of /reviews).
 *
 * NOTE ON PLACEMENT: the batch's enumerated server files had no home
 * for review requests, so this is a new file (no existing file
 * touched).
 *
 * Rules (old phase-7 insert policy + resolve_review_request, ported):
 * - Student files a request ONLY for their own RELEASED submission.
 *   The assessment's real owner becomes teacher_id server-side —
 *   the client never supplies it. An optional question must belong
 *   to that assessment. No question_keys, no other student's data.
 * - Student lists: WHERE student_id = caller. Teacher lists:
 *   WHERE teacher_id = caller. Display maps are built only from
 *   submissions visible to the caller (own submissions for a
 *   student; own assessments' submissions for a teacher), and names
 *   only for students the caller is entitled to see (own name for
 *   a student; request students for a teacher).
 * - Resolve: the old `resolve_review_request` returned false unless
 *   the row's teacher_id was the caller, and set status = 'resolved'
 *   with the response (max 5000 chars). A teacher can change only
 *   status/response — there is no direct update path here.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";

export type Caller = { id: string; role: string };

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export function isTeacherCaller(caller: Caller): boolean {
  const role = normalizeRole(caller.role);
  return role === "school_teacher" || role === "tutor";
}

export class ReviewError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "NOT_FOUND" | "INVALID_INPUT",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ReviewError";
  }
}

export type ReviewRow = {
  id: string;
  submission_id: string;
  question_id: string | null;
  student_id: string;
  teacher_id: string;
  message: string;
  status: string;
  teacher_response: string;
  created_at: string;
  resolved_at: string | null;
};

export async function listReleasedForStudent(
  db: D1Database,
  caller: Caller,
): Promise<{ id: string; assessment_id: string }[]> {
  if (normalizeRole(caller.role) !== "student") {
    throw new ReviewError("FORBIDDEN");
  }
  const { results } = await db
    .prepare(
      "SELECT id, assessment_id FROM submissions WHERE student_id = ? AND status = 'released'",
    )
    .bind(caller.id)
    .all<{ id: string; assessment_id: string }>();
  return results ?? [];
}

export type ReviewQuestion = { id: string; prompt: string };

/**
 * Questions (prompt only, never keys) for an assessment the student
 * has a RELEASED submission for. A forged or unreleased assessment
 * id yields FORBIDDEN, never the questions.
 */
export async function listQuestionsForReleasedAssessment(
  db: D1Database,
  caller: Caller,
  assessmentId: string,
): Promise<ReviewQuestion[]> {
  if (normalizeRole(caller.role) !== "student") {
    throw new ReviewError("FORBIDDEN");
  }
  const sub = await db
    .prepare(
      "SELECT id FROM submissions WHERE assessment_id = ? AND student_id = ? AND status = 'released' LIMIT 1",
    )
    .bind(assessmentId, caller.id)
    .first<{ id: string }>();
  if (!sub) {
    throw new ReviewError("FORBIDDEN");
  }
  const { results } = await db
    .prepare("SELECT id, prompt FROM questions WHERE assessment_id = ? ORDER BY position")
    .bind(assessmentId)
    .all<ReviewQuestion>();
  return results ?? [];
}

export async function listReviewRequests(db: D1Database, caller: Caller): Promise<ReviewRow[]> {
  const role = normalizeRole(caller.role);
  const col = role === "student" ? "student_id" : "teacher_id";
  if (role !== "student" && !isTeacherCaller(caller)) {
    throw new ReviewError("FORBIDDEN");
  }
  const { results } = await db
    .prepare(
      "SELECT id, submission_id, question_id, student_id, teacher_id, message, status, " +
        "teacher_response, created_at, resolved_at FROM grade_review_requests " +
        `WHERE ${col} = ? ORDER BY created_at DESC`,
    )
    .bind(caller.id)
    .all<ReviewRow>();
  return results ?? [];
}

function inPlaceholders(ids: string[]): string {
  return ids.map(() => "?").join(",");
}

export type ReviewMaps = {
  submissionToAssessment: Record<string, string>;
  assessmentTitles: Record<string, string>;
  names: Record<string, string>;
  questionPrompts: Record<string, string>;
};

/**
 * Display maps, scoped to the caller's visible submissions only.
 * Caller-supplied id lists are intersected with visibility in SQL:
 * a student sees only their own submissions; a teacher sees only
 * submissions for their own assessments.
 */
export async function getReviewMaps(
  db: D1Database,
  caller: Caller,
  input: { submissionIds: string[]; studentIds: string[]; questionIds: string[] },
): Promise<ReviewMaps> {
  const role = normalizeRole(caller.role);
  const empty: ReviewMaps = {
    submissionToAssessment: {},
    assessmentTitles: {},
    names: {},
    questionPrompts: {},
  };
  if (input.submissionIds.length === 0) return empty;
  const vis = await db
    .prepare(
      "SELECT s.id AS id, s.assessment_id AS assessment_id FROM submissions s " +
        "JOIN assessments a ON a.id = s.assessment_id " +
        `WHERE s.id IN (${inPlaceholders(input.submissionIds)}) ` +
        (role === "student" ? "AND s.student_id = ?" : "AND a.teacher_id = ?"),
    )
    .bind(...input.submissionIds, caller.id)
    .all<{ id: string; assessment_id: string }>();
  const visible = vis.results ?? [];
  const submissionToAssessment: Record<string, string> = {};
  for (const s of visible) submissionToAssessment[s.id] = s.assessment_id;
  const assessmentIds = [...new Set(visible.map((s) => s.assessment_id))];
  const assessmentTitles: Record<string, string> = {};
  if (assessmentIds.length > 0) {
    const { results } = await db
      .prepare(`SELECT id, title FROM assessments WHERE id IN (${inPlaceholders(assessmentIds)})`)
      .bind(...assessmentIds)
      .all<{ id: string; title: string }>();
    for (const a of results ?? []) assessmentTitles[a.id] = a.title;
  }
  const names: Record<string, string> = {};
  const nameIds = role === "student" ? [caller.id] : input.studentIds.filter((id) => id.length > 0);
  if (nameIds.length > 0) {
    const { results } = await db
      .prepare(`SELECT id, full_name FROM profiles WHERE id IN (${inPlaceholders(nameIds)})`)
      .bind(...nameIds)
      .all<{ id: string; full_name: string | null }>();
    for (const p of results ?? []) names[p.id] = p.full_name || "—";
  }
  const questionPrompts: Record<string, string> = {};
  if (input.questionIds.length > 0 && assessmentIds.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT id, prompt FROM questions WHERE id IN (${inPlaceholders(input.questionIds)}) ` +
          `AND assessment_id IN (${inPlaceholders(assessmentIds)})`,
      )
      .bind(...input.questionIds, ...assessmentIds)
      .all<{ id: string; prompt: string }>();
    for (const q of results ?? []) questionPrompts[q.id] = q.prompt;
  }
  return { submissionToAssessment, assessmentTitles, names, questionPrompts };
}

export async function submitReviewRequest(
  db: D1Database,
  caller: Caller,
  input: { submissionId: string; questionId: string | null; message: string },
): Promise<{ id: string }> {
  if (normalizeRole(caller.role) !== "student") {
    throw new ReviewError("FORBIDDEN");
  }
  if (!input.message.trim()) throw new ReviewError("INVALID_INPUT");
  const sub = await db
    .prepare("SELECT assessment_id, student_id, status FROM submissions WHERE id = ?")
    .bind(input.submissionId)
    .first<{ assessment_id: string; student_id: string; status: string }>();
  if (!sub) throw new ReviewError("NOT_FOUND");
  if (sub.student_id !== caller.id) {
    throw new ReviewError("FORBIDDEN");
  }
  if (sub.status !== "released") {
    throw new ReviewError("INVALID_INPUT");
  }
  const assessment = await db
    .prepare("SELECT teacher_id FROM assessments WHERE id = ?")
    .bind(sub.assessment_id)
    .first<{ teacher_id: string }>();
  if (!assessment) throw new ReviewError("NOT_FOUND");
  if (input.questionId) {
    const q = await db
      .prepare("SELECT assessment_id FROM questions WHERE id = ?")
      .bind(input.questionId)
      .first<{ assessment_id: string }>();
    if (!q || q.assessment_id !== sub.assessment_id) {
      throw new ReviewError(
        "INVALID_INPUT",
        "Question does not belong to the submission's assessment.",
      );
    }
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO grade_review_requests " +
        "(id, submission_id, question_id, student_id, teacher_id, message, status, teacher_response) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'pending', '')",
    )
    .bind(
      id,
      input.submissionId,
      input.questionId,
      caller.id,
      assessment.teacher_id,
      input.message.trim(),
    )
    .run();
  return { id };
}

export async function resolveReviewRequest(
  db: D1Database,
  caller: Caller,
  requestId: string,
  response: string,
): Promise<boolean> {
  if (!isTeacherCaller(caller)) {
    throw new ReviewError("FORBIDDEN");
  }
  if (response.length > 5000) return false;
  const row = await db
    .prepare("SELECT teacher_id FROM grade_review_requests WHERE id = ?")
    .bind(requestId)
    .first<{ teacher_id: string }>();
  if (!row || row.teacher_id !== caller.id) return false;
  await db
    .prepare(
      "UPDATE grade_review_requests SET status = 'resolved', teacher_response = ?, " +
        "resolved_at = ? WHERE id = ?",
    )
    .bind(response, new Date().toISOString(), requestId)
    .run();
  return true;
}

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

function ctxCaller(context: unknown): Caller {
  const s = ctxSession(context);
  return { id: s.userId, role: s.role };
}

export const listReleasedForStudentD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listReleasedForStudent(ctxDb(context), ctxCaller(context)));

export const listQuestionsForReleasedAssessmentD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string })
  .handler(async ({ data, context }) =>
    listQuestionsForReleasedAssessment(ctxDb(context), ctxCaller(context), data.assessmentId),
  );

export const listReviewRequestsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listReviewRequests(ctxDb(context), ctxCaller(context)));

export const getReviewMapsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) =>
      data as { submissionIds: string[]; studentIds: string[]; questionIds: string[] },
  )
  .handler(async ({ data, context }) => getReviewMaps(ctxDb(context), ctxCaller(context), data));

export const submitReviewRequestD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) => data as { submissionId: string; questionId: string | null; message: string },
  )
  .handler(async ({ data, context }) =>
    submitReviewRequest(ctxDb(context), ctxCaller(context), data),
  );

export const resolveReviewRequestD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { requestId: string; response: string })
  .handler(async ({ data, context }) =>
    resolveReviewRequest(ctxDb(context), ctxCaller(context), data.requestId, data.response),
  );
